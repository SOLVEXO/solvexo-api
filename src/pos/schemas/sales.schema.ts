/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';


export type SaleDocument = Sale & Document;

@Schema({ _id: true })
export class SaleItem {
  @Prop({ type: String, default: null })
  productId: string | null;   // null for a CUSTOM item (a sale line with no catalog product)

  @Prop({ type: String, default: null })
  variantId: string | null;

  @Prop({ required: true })
  name: string;                 // snapshot — "Ceramic Mug (Blue)"

  @Prop({ required: true })
  sku: string;                  // 'CUSTOM' for a custom item

  @Prop({ type: String, default: null })
  image: string | null;         // product image snapshot

  @Prop({ type: Number, required: true })
  price: number;                // the price actually CHARGED (for a synced offline sale: what the till collected)

  // Offline sales only: the variant's list price when the sale was synced, and whether the charged price was a genuine
  // price of that variant within the offline window (false → flagged for review).
  @Prop({ type: Number, default: null })
  listPrice: number | null;

  @Prop({ type: Boolean, default: true })
  priceVerified: boolean;

  @Prop({ type: Number, required: true })
  qty: number;

  @Prop({ type: Number, required: true })
  lineTotal: number;

  // G1b: integer minor-unit twins (see common/schema-types/minor-money.ts). lineTotalMinor = toMinor(price × qty) is AUTHORITATIVE;
  // priceMinor × qty can differ from it only for a price with sub-minor decimals.
  @Prop({ type: 'MinorMoney' })
  priceMinor?: number;

  @Prop({ type: 'MinorMoney' })
  listPriceMinor?: number;

  @Prop({ type: 'MinorMoney' })
  lineTotalMinor?: number;

  @Prop({ type: Number, default: 0 })
  refundedQty: number;          // cumulative qty refunded from this line

  // G2.4 custom item: a line with no product — never touches stock; `taxCategory` 'exempt' = no tax on this line;
  // `customApprovedBy` = the manager who approved it (or null when under the store's no-approval limit)
  @Prop({ type: Boolean, default: false })
  isCustom?: boolean;

  @Prop({ type: String, enum: ['standard', 'exempt'], default: 'standard' })
  taxCategory?: string;

  @Prop({ type: String, default: null })
  customApprovedBy?: string | null;

  @Prop({ type: String, default: null })
  note?: string | null;

  // ── G2.5 per-line tax breakdown (minor units; Σ over the lines = the sale's discount / tax) and the PCT / HS code SNAPSHOT at sale time ──
  @Prop({ type: 'MinorMoney' }) discountShareMinor?: number;
  @Prop({ type: 'MinorMoney' }) netMinor?: number;
  @Prop({ type: 'MinorMoney' }) taxMinor?: number;
  @Prop({ type: String, default: null }) hsCode?: string | null;
}
export const SaleItemSchema = SchemaFactory.createForClass(SaleItem);

/** One tender taken for a sale. `amount` is what was APPLIED to the total (cash net of change). */
@Schema({ _id: false })
export class SalePayment {
  @Prop({ enum: ['cash', 'card', 'other', 'raast_qr'], required: true })
  method: string;

  @Prop({ type: Number, required: true })
  amount: number;
  // G1b: integer minor-unit twins

  @Prop({ type: 'MinorMoney' })
  amountMinor?: number;

  // cash only — what the customer handed over; change = tendered − amount, stored once on the sale
  @Prop({ type: Number })
  tendered?: number;

  @Prop({ type: 'MinorMoney' })
  tenderedMinor?: number;

  // card auth code / bank transfer ref / etc.
  @Prop({ type: String, default: null })
  reference: string | null;

  // digital tenders (raast_qr): the confirmed payment (payment_intents id) this line settles; `reference` holds the provider's reference
  @Prop({ type: String, default: null })
  intentId?: string | null;
}
export const SalePaymentSchema = SchemaFactory.createForClass(SalePayment);

/** One refund event against a sale — what came back, to which tenders, and in what currency. */
@Schema({ _id: false })
export class SaleRefund {
  @Prop({ type: Number, required: true })
  amount: number;
  // G1b: integer minor-unit twin

  @Prop({ type: 'MinorMoney' })
  amountMinor?: number;

  @Prop({ enum: ['full', 'partial'], required: true })
  kind: string;

  @Prop({ type: [{ _id: false, method: String, amount: Number, amountMinor: { type: 'MinorMoney' } }], default: [] })
  tenders: Array<{ method: string; amount: number; amountMinor?: number }>;

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

  // G1a: id of this refund's own PosRefund record (additive; absent on refunds that predate the backfill).
  @Prop({ type: String, default: null })
  refundId?: string | null;
}
export const SaleRefundSchema = SchemaFactory.createForClass(SaleRefund);

/** The tax invoice header of a completed sale: immutable number + seller snapshot + (empty) fiscal placeholders. */
@Schema({ _id: false })
export class SaleInvoice {
  @Prop({ required: true }) number: string;            // INV-000123 — per-store, gap-free, never reused
  @Prop({ type: Number, required: true }) seq: number;
  @Prop({ type: Date, required: true }) issuedAt: Date; // the sale's own time (an offline sale keeps its device time)
  @Prop({ type: String, default: null }) offlineRef: string | null; // the provisional OFF-… number the till printed before the sale synced
  @Prop({ type: Object, default: null }) seller: { legalName: string | null; address: string | null; ntn: string | null; strn: string | null } | null;
  @Prop({ type: Object, default: () => ({ status: 'not_enabled', externalInvoiceNumber: null, qrPayload: null, attempts: 0, lastError: null }) })
  fiscal: { status: string; externalInvoiceNumber: string | null; qrPayload: string | null; attempts: number; lastError: string | null };
}
export const SaleInvoiceSchema = SchemaFactory.createForClass(SaleInvoice);

@Schema({ timestamps: true })
export class Sale {
  /** G2.5 tax invoice (absent on a held sale — the number is minted when the sale completes — and on sales that predate G2.5) */
  @Prop({ type: SaleInvoiceSchema, default: null })
  invoice: SaleInvoice | null;

  /** G2.4: a HELD sale remembers the coupon CODE the cashier had (not a reservation — nothing is counted or discounted until it is completed;
   *  the code is checked again, server-side, when the sale is resumed / completed). */
  @Prop({ type: String, default: null })
  heldCouponCode: string | null;

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
  // G1b: integer minor-unit twin

  @Prop({ type: 'MinorMoney' })
  subtotalMinor?: number;

  @Prop({ type: Number, default: 0 })
  discount: number;

  @Prop({ type: 'MinorMoney' })
  discountMinor?: number;

  @Prop({ type: Number, default: 0 })
  tax: number;

  @Prop({ type: 'MinorMoney' })
  taxMinor?: number;

  @Prop({ type: Number, required: true })
  total: number;

  @Prop({ type: 'MinorMoney' })
  totalMinor?: number;

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

  @Prop({ type: 'MinorMoney' })
  discountValueMinor?: number;

  @Prop({ type: Number, default: null })
  taxRate: number | null;

  // 'split' when more than one tender was used. For old single-payment sales this is the only payment info.
  @Prop({ enum: ['cash', 'card', 'other', 'raast_qr', 'split'], default: 'cash' })
  paymentMethod: string;

  // G2.4 digital receipt: an unguessable capability token (192 bits). `revokedAt` set = the link no longer works.
  @Prop({ type: Object, default: null })
  receipt?: { token: string; createdAt: Date; revokedAt: Date | null; revokedBy?: string | null } | null;

  // G2.4 coupon (storefront Coupon model, POS channel): the code, its id, and the discount it gave (minor units)
  @Prop({ type: String, default: null })
  couponCode?: string | null;

  @Prop({ type: String, default: null })
  couponId?: string | null;

  @Prop({ type: 'MinorMoney' })
  couponDiscountMinor?: number;

  // Tender lines (empty for held sales and for sales made before split tender — see effectivePayments()).
  @Prop({ type: [SalePaymentSchema], default: [] })
  payments: SalePayment[];

  // Cash handed back to the customer (computed server-side from the cash tendered).
  @Prop({ type: Number, default: 0 })
  changeGiven: number;

  @Prop({ type: 'MinorMoney' })
  changeGivenMinor?: number;

  // Snapshot of who rang it up, so a receipt can print a cashier name without another lookup.
  @Prop({ type: String, default: null })
  employeeName: string | null;

  @Prop({ type: [SaleRefundSchema], default: [] })
  refunds: SaleRefund[];

  // ── Offline sync (Phase 5C) ──────────────────────────────────────────────────────────────────
  // A sale rung up while the device had no connection is replayed later with the time it was REALLY made.
  // `createdAt` then carries that time (so reports, shifts and receipts are right); `receivedAt` is when the
  // server actually got it, and `clientCreatedAt` the raw device timestamp.
  // The manager whose verified PIN session authorised the discount (online or offline).
  @Prop({ type: String, default: null })
  approvedBy: string | null;

  @Prop({ type: Date, default: null })
  approvedAt: Date | null;

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

  @Prop({ type: 'MinorMoney' })
  paymentShortfallMinor?: number;

  @Prop({ type: String, default: null })
  customerId: string | null;

  @Prop({ default: 'Walk-in' })
  customerName: string;

  @Prop({ type: String, default: null })
  notes: string | null;

  @Prop({ type: Date, default: null })
  heldAt: Date | null;          // timestamp when sale was put on hold

  @Prop({ enum: ['completed', 'held', 'refunded', 'voided', 'partially_refunded', 'discarded'], default: 'completed' })
  status: string;

  // G1a transaction context — always set server-side (session / authenticated device), never read from the request body.
  @Prop({ type: String, default: null })
  shiftId: string | null;

  @Prop({ type: String, default: null })
  deviceId: string | null;

  // G1a soft delete of a held sale (status 'discarded'). Rows with deletedAt set are excluded from every list.
  @Prop({ type: Date, default: null })
  deletedAt: Date | null;

  @Prop({ type: String, default: null })
  deletedBy: string | null;     // employeeId (PIN session) or the owner's seller id

  @Prop({ type: String, default: null })
  deleteReason: string | null;

  @Prop({ type: String, default: null })
  deleteReasonCode?: string | null;

  @Prop({ type: String, default: null })
  voidReason?: string | null;

  @Prop({ type: String, default: null })
  voidReasonCode?: string | null;

  // set only by the G1a backfill so it can be reversed
  @Prop({ type: Boolean })
  shiftIdBackfilled?: boolean;

  // G1b backfill markers (so `down` removes only what the backfill added; live dual-written rows never carry them)
  @Prop({ type: Date })
  minorBackfilledAt?: Date;

  /** The currency/exponent snapshot was missing (pre-5B) and was inferred from the store's baseCurrency by the backfill. */
  @Prop({ type: Boolean })
  currencyInferred?: boolean;

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

  @Prop({ type: 'MinorMoney' })
  refundedAmountMinor?: number;
}

export const SaleSchema = SchemaFactory.createForClass(Sale);
// MinorMoney fields are stored as BSON long and read back through a getter: serialise documents with getters so JSON carries plain numbers.
SaleSchema.set('toJSON', { getters: true, virtuals: false });
SaleSchema.set('toObject', { getters: true, virtuals: false });

// G2.5: the invoice number is unique per store and never reused (partial: held sales and pre-G2.5 sales have none)
SaleSchema.index({ storeId: 1, 'invoice.seq': 1 }, { unique: true, partialFilterExpression: { 'invoice.seq': { $type: 'number' } }, name: 'uniq_invoice_seq_per_store' });
SaleSchema.index({ storeId: 1, 'invoice.number': 1 }, { unique: true, partialFilterExpression: { 'invoice.number': { $type: 'string' } }, name: 'uniq_invoice_number_per_store' });

// G2.5: an invoice number, once written, is immutable. The only update that may set `invoice` is the one that first issues it
// (its filter asks for `invoice.number: null` — i.e. the sale does not have one yet); every other update touching it is refused.
const INVOICE_KEYS = /^invoice(\.|$)/;
SaleSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'] as any, function (this: any) {
  const u = this.getUpdate?.() ?? {};
  const keys = [...Object.keys(u.$set ?? {}), ...Object.keys(u.$unset ?? {}), ...Object.keys(u).filter((k) => !k.startsWith('$'))];
  if (!keys.some((k) => INVOICE_KEYS.test(k))) return;
  const f = this.getFilter?.() ?? {};
  const issuing = Object.prototype.hasOwnProperty.call(f, 'invoice.number') && (f['invoice.number'] === null || (f['invoice.number'] && f['invoice.number'].$exists === false));
  if (!issuing) throw new Error('The invoice of a sale is immutable: it can only be issued once, never changed');
});

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
// the public receipt page looks a sale up by its token (unique; only sales that have one are indexed)
SaleSchema.index({ 'receipt.token': 1 }, { unique: true, partialFilterExpression: { 'receipt.token': { $type: 'string' } } });
