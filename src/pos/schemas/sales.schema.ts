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

  @Prop({ type: String, default: null })
  idempotencyKey: string | null;

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
SaleSchema.index({ sessionId: 1 });
SaleSchema.index({ employeeId: 1 });
SaleSchema.index({ storeId: 1, saleNumber: 1 }, { unique: true });
SaleSchema.index({ 'items.variantId': 1 });
SaleSchema.index({ idempotencyKey: 1 }, { sparse: true });
