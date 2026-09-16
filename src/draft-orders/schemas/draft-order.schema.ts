/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DraftOrderDocument = HydratedDocument<DraftOrder>;

@Schema({ _id: true })
export class DraftOrderItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  variantId: string;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: [{ name: String, value: String }], default: [] })
  options: { name: string; value: string }[];

  @Prop({ required: true })
  quantity: number;

  // The price the seller is charging on THIS draft order — defaults to the
  // variant's current price at add-time but is explicitly editable (a
  // manually-created order routinely needs a one-off price: a wholesale
  // deal, a goodwill discount, a phone-order negotiated price). Never
  // silently re-derived from the live product price later.
  @Prop({ required: true })
  unitPrice: number;
}

export const DraftOrderItemSchema = SchemaFactory.createForClass(DraftOrderItem);

@Schema({ _id: false })
export class DraftOrderShippingAddress {
  @Prop({ type: String, required: true })
  recipientName: string;

  @Prop({ type: String, required: true })
  addressLine1: string;

  @Prop({ type: String, default: '' })
  addressLine2: string;

  @Prop({ type: String, required: true })
  city: string;

  @Prop({ type: String, default: '' })
  state: string;

  @Prop({ type: String, default: '' })
  zipCode: string;

  @Prop({ type: String, required: true })
  phoneNumber: string;
}

export const DraftOrderShippingAddressSchema = SchemaFactory.createForClass(DraftOrderShippingAddress);

@Schema({ timestamps: true })
export class DraftOrder {
  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  // Set only once a real registered buyer account is attached — required to
  // actually convert this draft into a real `Order` (`Order.userId` is a
  // hard, non-nullable foreign key on that schema; a purely "guest" draft
  // can be built, priced, and sent as an invoice, but genuinely cannot
  // become a real Order until a registered account is linked). This is a
  // real, disclosed architectural boundary, not an oversight.
  @Prop({ type: String, default: null })
  customerId: string | null;

  @Prop({ type: String, required: true })
  customerName: string;

  @Prop({ type: String, default: null })
  customerEmail: string | null;

  @Prop({ type: String, default: null })
  customerPhone: string | null;

  @Prop({ type: [DraftOrderItemSchema], default: [] })
  items: DraftOrderItem[];

  // Real shipping-address capture (previously absent entirely — `complete()`
  // hardcoded `Order.shippingAddress: null` regardless of what the seller
  // actually knew about the customer). Optional — a digital-only or
  // in-person/pickup draft has no shipping address to capture.
  @Prop({ type: DraftOrderShippingAddressSchema, default: null })
  shippingAddress: DraftOrderShippingAddress | null;

  // Real Shopify-equivalent payment terms — when set, `complete()` copies
  // both fields onto the resulting Order (informational + used to compute
  // an overdue reminder) rather than an unconditional "paid now" assumption.
  @Prop({ type: String, enum: ['due_on_receipt', 'net_15', 'net_30', 'net_60', null], default: null })
  paymentTerms: 'due_on_receipt' | 'net_15' | 'net_30' | 'net_60' | null;

  @Prop({ type: Date, default: null })
  dueDate: Date | null;

  @Prop({ type: String, enum: ['percentage', 'fixed', null], default: null })
  discountType: 'percentage' | 'fixed' | null;

  @Prop({ type: Number, default: 0 })
  discountValue: number;

  @Prop({ type: Number, default: 0 })
  shippingAmount: number;

  @Prop({ type: Number, default: 0 })
  taxAmount: number;

  @Prop({ type: String, default: '' })
  notes: string;

  // Always the store's own baseCurrency — a manually-priced merchant order
  // has no buyer-currency-preference concept to resolve.
  @Prop({ type: String, required: true })
  currency: string;

  // Denormalized/cached on every save (DraftOrdersService.recalculate) so
  // list views never need to recompute from `items` client-side.
  @Prop({ type: Number, default: 0 })
  subtotal: number;

  @Prop({ type: Number, default: 0 })
  discountAmount: number;

  @Prop({ type: Number, default: 0 })
  total: number;

  @Prop({ type: String, enum: ['open', 'completed', 'cancelled'], default: 'open' })
  status: 'open' | 'completed' | 'cancelled';

  // Real, independent "payment collected" flag — set only by `markAsPaid()`,
  // never implicitly by `complete()`. Lets a seller record that they've
  // actually collected payment (cash/bank transfer/etc.) for an open draft
  // before converting it, instead of `complete()` blindly force-marking
  // every resulting Order as paid regardless of whether money changed hands.
  @Prop({ type: Boolean, default: false })
  isPaid: boolean;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  // Set once `complete()` successfully converts this draft into a real Order.
  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ type: String, default: null })
  orderNumber: string | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  // Real "Send invoice" — a secure, random, non-guessable token that
  // identifies this draft on the PUBLIC payment page (never the raw Mongo
  // _id, which is guessable/enumerable). Null until `sendInvoice()` first
  // generates one; regenerated (invalidating any previously-emailed link)
  // whenever the draft's priced content changes after being sent, so a
  // stale emailed link can never be used to pay an outdated total.
  @Prop({ type: String, default: null, index: true })
  invoiceToken: string | null;

  @Prop({ type: Date, default: null })
  invoiceSentAt: Date | null;

  // Independent from `isPaid` (which a SELLER sets via markAsPaid for a
  // manually-collected payment) — this is set only when the CUSTOMER pays
  // for themselves through the public invoice link's real Stripe checkout.
  @Prop({ type: Date, default: null })
  invoicePaidAt: Date | null;

  // Real overdue-invoice dunning dedup — set once
  // DraftOrdersService.sendOverdueInvoiceReminders emails the customer an
  // overdue reminder for this draft's `dueDate`, so the same open invoice
  // never gets re-emailed on every subsequent daily cron tick. Reset back to
  // null whenever `paymentTerms`/`dueDate` change (see `update()`) so a
  // pushed-out due date re-arms the check against its new date.
  @Prop({ type: Date, default: null })
  overdueReminderSentAt: Date | null;

  // Standard soft-delete convention this app uses everywhere else (Product/
  // Order/etc.) — previously absent, so "Delete" only ever existed as
  // `cancel()`'s status flip. Real delete stays restricted to a draft that
  // was never completed (see DraftOrdersService.deleteDraft) — a completed
  // draft has a real linked Order and must never disappear from history.
  @Prop({ type: Boolean, default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const DraftOrderSchema = SchemaFactory.createForClass(DraftOrder);

DraftOrderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
