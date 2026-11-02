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

/** One tender taken for a sale. `amount` is what was APPLIED to the total (cash net of change). */
@Schema({ _id: false })
export class SalePayment {
  @Prop({ enum: ['cash', 'card', 'other'], required: true })
  method: string;

  @Prop({ type: Number, required: true })
  amount: number;

  // cash only — what the customer handed over; change = tendered − amount, stored once on the sale
  @Prop({ type: Number })
  tendered?: number;

  // card auth code / bank transfer ref / etc.
  @Prop({ type: String, default: null })
  reference: string | null;
}
export const SalePaymentSchema = SchemaFactory.createForClass(SalePayment);

/** One refund event against a sale — what came back, to which tenders, and in what currency. */
@Schema({ _id: false })
export class SaleRefund {
  @Prop({ type: Number, required: true })
  amount: number;

  @Prop({ enum: ['full', 'partial'], required: true })
  kind: string;

  @Prop({ type: [{ _id: false, method: String, amount: Number }], default: [] })
  tenders: Array<{ method: string; amount: number }>;

  @Prop({ type: [{ _id: false, saleItemId: String, qty: Number }], default: [] })
  items: Array<{ saleItemId: string; qty: number }>;

  @Prop({ type: String, default: null })
  employeeId: string | null;

  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: Number, default: null })
  currencyExponent: number | null;

  @Prop({ type: Date, default: () => new Date() })
  createdAt: Date;
}
export const SaleRefundSchema = SchemaFactory.createForClass(SaleRefund);

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

  // ── Currency snapshot (Phase 5B / D1) ─────────────────────────────────────────────────────────
  // The store's currency at the moment of sale and its ISO-4217 minor-unit exponent (JPY 0, USD/PKR 2,
  // KWD 3). Every amount on this sale is rounded to that exponent. Sales created before 5B have neither
  // field; readers fall back to the store's current baseCurrency.
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ type: Number, default: null })
  currencyExponent: number | null;

  // What the cashier entered for the discount (the server computed `discount` from it) and the tax rate
  // that was applied — kept so a receipt can say "10% off" / "Tax (8%)" without guessing.
  @Prop({ type: String, enum: ['amount', 'percent', null], default: null })
  discountType: string | null;

  @Prop({ type: Number, default: null })
  discountValue: number | null;

  @Prop({ type: Number, default: null })
  taxRate: number | null;

  // 'split' when more than one tender was used. For old single-payment sales this is the only payment info.
  @Prop({ enum: ['cash', 'card', 'other', 'split'], default: 'cash' })
  paymentMethod: string;

  // Tender lines (empty for held sales and for sales made before split tender — see effectivePayments()).
  @Prop({ type: [SalePaymentSchema], default: [] })
  payments: SalePayment[];

  // Cash handed back to the customer (computed server-side from the cash tendered).
  @Prop({ type: Number, default: 0 })
  changeGiven: number;

  // Snapshot of who rang it up, so a receipt can print a cashier name without another lookup.
  @Prop({ type: String, default: null })
  employeeName: string | null;

  @Prop({ type: [SaleRefundSchema], default: [] })
  refunds: SaleRefund[];

  // ── Offline sync (Phase 5C) ──────────────────────────────────────────────────────────────────
  // A sale rung up while the device had no connection is replayed later with the time it was REALLY made.
  // `createdAt` then carries that time (so reports, shifts and receipts are right); `receivedAt` is when the
  // server actually got it, and `clientCreatedAt` the raw device timestamp.
  @Prop({ type: Boolean, default: false })
  isOffline: boolean;

  @Prop({ type: Date, default: null })
  clientCreatedAt: Date | null;

  @Prop({ type: Date, default: null })
  receivedAt: Date | null;

  // The settingsVersion (tax rate etc.) this sale was priced with.
  @Prop({ type: Number, default: null })
  settingsVersion: number | null;

  // Something a manager should look at: oversell on sync, price changed while offline, sale into a closed
  // session, a payment shortfall. Cleared by POST /pos/sales/:id/resolve-review.
  @Prop({ type: [{ _id: false, type: { type: String }, detail: { type: Object } }], default: [] })
  flags: Array<{ type: string; detail: Record<string, any> }>;

  @Prop({ type: Boolean, default: false })
  needsReview: boolean;

  @Prop({ type: String, default: null })
  reviewedBy: string | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  @Prop({ type: String, default: null })
  reviewNote: string | null;

  // Offline sales only: what the server priced minus what the customer was actually charged on the device (>0 =
  // the shop is owed the difference). Never rejects money that already changed hands — it is recorded and flagged.
  @Prop({ type: Number, default: 0 })
  paymentShortfall: number;

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
