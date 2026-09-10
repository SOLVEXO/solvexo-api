/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SaleDocument = Sale & Document;

@Schema({ _id: true })
export class SaleItem {
  @Prop({ required: true })
  productId: string;

  @Prop({ required: true })
  variantId: string;

  @Prop({ required: true })
  name: string;                 // snapshot — "Ceramic Mug (Blue)"

  @Prop({ required: true })
  sku: string;

  @Prop({ type: String, default: null })
  image: string | null;         // product image snapshot

  @Prop({ type: Number, required: true })
  price: number;                // snapshot — price at time of sale

  @Prop({ type: Number, required: true })
  qty: number;

  @Prop({ type: Number, required: true })
  lineTotal: number;            // price × qty

  @Prop({ type: Number, default: 0 })
  refundedQty: number;          // cumulative qty refunded from this line
}
export const SaleItemSchema = SchemaFactory.createForClass(SaleItem);

@Schema({ timestamps: true })
export class Sale {
  @Prop({ required: true })
  saleNumber: string;           // human-readable receipt number e.g. "POS-00001" — unique per store, see compound index below

  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  sessionId: string;

  @Prop({ required: true })
  registerId: string;

  // Denormalized from the RegisterSession at sale-creation time — powers
  // per-location sales reporting without a join.
  @Prop({ type: String, default: null })
  locationId: string | null;

  @Prop({ required: true })
  employeeId: string;

  @Prop({ type: [SaleItemSchema], default: [] })
  items: SaleItem[];

  @Prop({ type: Number, default: 0 })
  subtotal: number;

  @Prop({ type: Number, default: 0 })
  discount: number;

  @Prop({ type: Number, default: 0 })
  tax: number;

  @Prop({ type: Number, required: true })
  total: number;

  @Prop({ enum: ['cash', 'card', 'other'], default: 'cash' })
  paymentMethod: string;

  @Prop({ type: String, default: null })
  customerId: string | null;

  @Prop({ default: 'Walk-in' })
  customerName: string;

  @Prop({ type: String, default: null })
  notes: string | null;

  @Prop({ type: Date, default: null })
  heldAt: Date | null;          // timestamp when sale was put on hold

  @Prop({ enum: ['completed', 'held', 'refunded', 'voided', 'partially_refunded'], default: 'completed' })
  status: string;

  // No `default: null` — a `sparse` index only excludes documents where
  // the field is truly absent, not ones where it's explicitly `null`.
  // Mongoose applies a schema `default` even when the field is omitted
  // from `.create()`, so a default here would silently reintroduce the
  // exact E11000-on-every-key-less-sale bug the unique+sparse index (see
  // below) was meant to avoid. Leave the field unset entirely when no
  // client-generated key is supplied — see PosService.createSale.
  @Prop({ type: String })
  idempotencyKey?: string | null;

  @Prop({ type: Date, default: null })
  voidedAt: Date | null;

  @Prop({ type: String, default: null })
  voidedBy: string | null;      // employeeId who voided

  @Prop({ type: Number, default: 0 })
  refundedAmount: number;       // cumulative amount refunded (for partial refunds)
}

export const SaleSchema = SchemaFactory.createForClass(Sale);

SaleSchema.index({ storeId: 1, createdAt: -1 });
SaleSchema.index({ storeId: 1, status: 1 });
SaleSchema.index({ locationId: 1, createdAt: -1 });
SaleSchema.index({ sessionId: 1 });
SaleSchema.index({ employeeId: 1 });
SaleSchema.index({ storeId: 1, saleNumber: 1 }, { unique: true });
SaleSchema.index({ 'items.variantId': 1 });
// unique (not just sparse) — the old sparse-only index let two requests
// carrying the same client-generated idempotencyKey both pass a
// findOne-then-create check before either had written, creating duplicate
// sales on a retried checkout. See PosService.createSale's duplicate-key
// catch, which now relies on this constraint to detect that race.
SaleSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });
