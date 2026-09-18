import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { FxSnapshot, FxSnapshotSchema } from '../../exchange-rate/schemas/exchange-rate.schema';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: true })
export class OrderItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, default: null })
  variantId: string | null;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  // The product's own category — 'educational' collapses to `type: 'digital'` above
  // for fulfillment purposes, but is kept here too so order history/labels can
  // still say "Educational" instead of a generic "Digital". Absent on orders
  // placed before this field existed — display code must fall back to `type`.
  @Prop({
    type: String,
    enum: ['physical', 'digital', 'educational'],
    default: null,
  })
  productType: string | null;

  // snapshot fields
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: [{ name: String, value: String }], default: [] })
  options: { name: string; value: string }[];

  @Prop({ type: String, default: null })
  licenseType: string | null;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;

  // Set only when a subscriber discount was applied at checkout — kept for
  // order-history display ("member savings: $X") and seller analytics.
  @Prop({ type: Number, default: null })
  originalPrice: number | null;

  @Prop({ type: Number, default: 0 })
  subscriberDiscountUSD: number;

  // Coupon discount allocated to this line at checkout — see
  // CheckoutItem.couponDiscountUSD, copied through at order creation.
  @Prop({ type: Number, default: 0 })
  couponDiscountUSD: number;

  // Gift card discount allocated to this line at checkout — see
  // CheckoutItem.giftCardDiscountUSD, copied through at order creation.
  @Prop({ type: Number, default: 0 })
  giftCardDiscountUSD: number;

  // Automatic platform-campaign discount allocated to this line at checkout —
  // see CheckoutItem.campaignId/campaignDiscountUSD, copied through as-is.
  @Prop({ type: String, default: null })
  campaignId: string | null;

  @Prop({ type: Number, default: 0 })
  campaignDiscountUSD: number;

  // A seller's own no-code automatic discount (DiscountsService) allocated
  // to this line at checkout — see CheckoutItem.autoDiscountId/autoDiscountUSD.
  @Prop({ type: String, default: null })
  autoDiscountId: string | null;

  @Prop({ type: Number, default: 0 })
  autoDiscountUSD: number;

  // This line's share of its store's tax, copied through from
  // CheckoutItem.taxUSD at order-creation time — see that field's own doc
  // comment. Included in SellerOrder.taxAmount/settlementAmount so the
  // seller actually receives the tax money they're responsible for
  // remitting to their own government (Solvexo has no tax-filing engine of
  // its own — same real-world division of responsibility as Shopify).
  @Prop({ type: Number, default: 0 })
  taxUSD: number;

  // Who bears campaignDiscountUSD — see Campaign.sponsorType /
  // CheckoutItem.campaignSponsorType. 'platform' means this line's discount
  // was reimbursed to the seller (see SellerOrder.platformSponsoredDiscountUSD),
  // not absorbed out of their own payout.
  @Prop({ type: String, enum: ['seller', 'platform'], default: null })
  campaignSponsorType: 'seller' | 'platform' | null;

  // cancel/refund item-level pe
  @Prop({
    type: String,
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, default: null })
  cancelReason: string | null;

  @Prop({ default: 0 })
  refundedAmount: number;

  @Prop({ default: 0 })
  downloadCount!: number;

  // return fields
  @Prop({
    type: String,
    enum: ['none', 'requested', 'approved', 'rejected'],
    default: 'none',
  })
  returnStatus!: string;

  @Prop({ type: String, default: null })
  returnReason!: string | null;

  @Prop({ type: Date, default: null })
  returnRequestedAt!: Date | null;

  @Prop({ type: String, default: null })
  returnRejectReason!: string | null;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class OrderTracking {
  @Prop({ type: String, default: null })
  carrier: string | null;

  @Prop({ type: String, default: null })
  trackingNumber: string | null;

  @Prop({ type: String, default: null })
  trackingUrl: string | null;
}

export const OrderTrackingSchema = SchemaFactory.createForClass(OrderTracking);

// ek store ka hissa — status items se derive hota hai
@Schema({ _id: true })
export class SellerOrder {
  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({
    type: String,
    enum: ['physical', 'digital', 'mixed'],
    required: true,
  })
  fulfillmentType: string;

  @Prop({ type: [OrderItemSchema], required: true })
  items: OrderItem[];

  @Prop({ required: true, default: 0 })
  subtotal: number;

  // Sum of this store's items' campaignDiscountUSD where campaignSponsorType
  // is 'platform' — the amount FinanceService.recordSale credits back on top
  // of `subtotal` so a platform-sponsored discount never reduces this
  // seller's own payout (see FinanceService.recordSale's saleAmount param).
  @Prop({ type: Number, default: 0 })
  platformSponsoredDiscountUSD: number;

  // Sum of this store's items' taxUSD — the buyer WAS actually charged this
  // (folded into Checkout.totalAmount at checkout time), and this is what
  // makes that money reach the seller's own payout via `settlementAmount`
  // below, instead of being charged to the buyer but never credited
  // anywhere (the real, previously-undetected bug this field fixes). Same
  // real-world split as Shopify: the platform never keeps sales tax, the
  // seller receives it and is responsible for remitting it themselves.
  @Prop({ type: Number, default: 0 })
  taxAmount: number;

  // What this specific seller is actually credited, in THEIR OWN
  // Store.baseCurrency — independent of the buyer's checkout currency
  // (Order.currency above). Computed once at order-creation time
  // (OrdersService) from the parent Order's fxSnapshots and never
  // recomputed later; refunds/chargebacks reverse against this same
  // snapshotted figure. Null on orders created before this field existed
  // and on any sellerOrder whose settlement leg hasn't been computed yet.
  @Prop({ type: String, default: null })
  settlementCurrency: string | null;

  @Prop({ type: Number, default: null })
  settlementAmount: number | null;

  // True when this seller's charge was routed directly to their own
  // connected Stripe account (StripeConnectService) at payment time — see
  // PaymentTransaction.settledViaConnect. When true, OrdersService's
  // recordSale (fulfillment-triggered internal-ledger credit) is skipped
  // entirely for this sellerOrder: the money already reached the seller's
  // own bank account via Stripe's own payout schedule, so crediting the
  // internal ledger too would let them draw a SECOND, duplicate payout
  // through the platform's own payout-request flow.
  @Prop({ type: Boolean, default: false })
  settledViaConnect: boolean;

  @Prop({ type: String, default: null })
  stripeConnectedAccountId: string | null;

  // Cumulative total of standalone "Refund $X" actions issued against this
  // sellerOrder (OrdersService.refundOrderAsSeller) — in the BUYER's
  // checkout currency (Order.currency), same denomination `item.totalPrice`/
  // `executeCancellation`'s `totalBuyerRefund` already use, so refund caps
  // can be compared apples-to-apples. Deliberately separate from each
  // item's own `refundedAmount` (set only by cancellation/return) — a
  // standalone refund is never tied to cancelling or returning an item
  // (e.g. a goodwill partial refund, a shipping-fee waiver after the fact),
  // so it needed its own running total rather than overloading item-level
  // bookkeeping.
  @Prop({ type: Number, default: 0 })
  manualRefundedAmount: number;

  // Derived — see `order-status.util.ts#deriveSellerOrderStatus`, the ONE
  // function that computes this value; never hand-set independently.
  // `partially_cancelled`/`partially_refunded`/`partially_shipped` added
  // alongside that util (previously this enum had no way to represent a
  // seller order whose items were only partly cancelled/refunded, which is
  // exactly the state a partial buyer cancellation used to leave silently
  // stale at 'processing' or whatever it was before).
  @Prop({
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
      'partially_cancelled',
      'partially_refunded',
      'partially_shipped',
    ],
    default: 'pending',
  })
  status: string;

  @Prop({ type: OrderTrackingSchema, default: null })
  tracking: OrderTracking | null;

  @Prop({ type: Date, default: null })
  shippedAt: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, default: null })
  cancelReason: string | null;

  @Prop({
    type: String,
    enum: [
      'none',
      'partial_requested',
      'requested',
      'partial_approved',
      'approved',
      'rejected',
    ],
    default: 'none',
  })
  returnStatus!: string;
}

export const SellerOrderSchema = SchemaFactory.createForClass(SellerOrder);

@Schema({ _id: false })
export class OrderShippingAddress {
  @Prop({ type: String, required: true })
  recipientName: string;

  @Prop({ type: String, required: true })
  phoneNumber: string;

  @Prop({ type: String, required: true })
  addressLine1: string;

  @Prop({ type: String, default: null })
  addressLine2: string | null;

  @Prop({ type: String, required: true })
  city: string;

  @Prop({ type: String, required: true })
  state: string;

  @Prop({ type: String, required: true })
  zipCode: string;

  // Nullable — mirrors Address.country (optional/added later; a pre-existing
  // address saved before that field existed has none). Required for a real
  // live carrier label purchase (ShippingRatesService.purchaseLabel) but not
  // for anything else this schema is used for, so it stays optional here
  // too rather than breaking every historical order without it.
  @Prop({ type: String, default: null })
  country: string | null;
}

export const OrderShippingAddressSchema =
  SchemaFactory.createForClass(OrderShippingAddress);

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: String, required: true, unique: true })
  orderNumber: string;

  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  checkoutId: string;

  // The currency the buyer was actually charged, copied verbatim from
  // Checkout.currency at order-creation time — permanent once set, never
  // recomputed. No schema-level default anymore (see Checkout.currency's
  // comment); existing historical orders keep whatever value they already
  // have, including the old implicit 'USD' default, forever.
  @Prop({ type: String })
  currency: string;

  // Copied verbatim from Checkout.fxSnapshots at order-creation time —
  // immutable. This is what lets a refund, a settlement recomputation, or
  // an audit reproduce exactly what happened without depending on today's
  // ExchangeRate table. Absent on orders created before this field existed.
  @Prop({ type: [FxSnapshotSchema], default: [] })
  fxSnapshots: FxSnapshot[];

  // Units of `currency` (above) per 1 USD — same semantics as
  // FxSnapshot.ratePerUSD, captured once at order-creation from this order's
  // OWN immutable `fxSnapshots` (1 when `currency` is already 'USD', never a
  // fresh/live rate). Every amount on this Order and its sellerOrders
  // (subtotal, item totals, refunds, tax, shipping) is denominated in this
  // single `currency` — never mixed within one order — so ANY such field can
  // be normalized to USD via `amountUSD = amount / ratePerUSD`. This is what
  // lets analytics sum revenue ACROSS orders placed in different currencies
  // without silently blending PKR and USD figures into one meaningless
  // number (see admin-analytics/analytics order-aggregation.util.ts#toUSD).
  // null on an order whose `currency` is non-USD and has no matching
  // fxSnapshots entry — a genuine historical gap (an order placed before
  // this field existed, or before fxSnapshots existed) that must be
  // EXCLUDED from USD-normalized totals, never guessed at. Purely
  // additive: does not change `subtotal`/`totalAmount`/`settlementAmount`/
  // any other existing field on this document.
  @Prop({ type: Number, default: null })
  ratePerUSD: number | null;

  // har store ka hissa
  @Prop({ type: [SellerOrderSchema], required: true })
  sellerOrders: SellerOrder[];

  // digital-only order me null
  @Prop({ type: OrderShippingAddressSchema, default: null })
  shippingAddress: OrderShippingAddress | null;

  @Prop({ required: true, default: 0 })
  subtotal: number;

  // poore order ka single shipping (destination city rate)
  @Prop({ required: true, default: 0 })
  shippingFee: number;

  @Prop({ required: true, default: 0 })
  taxAmount: number;

  // Total subscriber-benefit savings across all items in this order —
  // powers seller analytics ("revenue from subscribers", "benefit usage").
  @Prop({ default: 0 })
  subscriberDiscountTotal: number;

  // Sum of each item's couponDiscountUSD (already applied per-item at
  // checkout time — see CheckoutService.distributeCouponDiscount), copied
  // through at order-creation time for receipt display and seller analytics.
  @Prop({ type: String, default: null })
  couponCode: string | null;

  @Prop({ default: 0 })
  couponDiscountTotal: number;

  // Same convention as couponCode/couponDiscountTotal above, but for a
  // GiftCard's balance applied at checkout — see Checkout.giftCardCode.
  @Prop({ type: String, default: null })
  giftCardCode: string | null;

  @Prop({ default: 0 })
  giftCardDiscountTotal: number;

  // Sum of every sellerOrder item's campaignDiscountUSD — see
  // Checkout.campaignDiscountTotalUSD for why there's no single order-level
  // campaignId (a multi-store order can carry a different campaign per store).
  @Prop({ default: 0 })
  campaignDiscountTotal: number;

  // Sum of every item's autoDiscountUSD — see Checkout.autoDiscountTotalUSD
  // for why there's no single order-level discount id (same multi-store
  // reasoning as campaignDiscountTotal above).
  @Prop({ default: 0 })
  autoDiscountTotal: number;

  // Sum of every sellerOrder's platformSponsoredDiscountUSD — how much of
  // campaignDiscountTotal above the platform is covering (vs. sellers
  // absorbing it themselves). 0 whenever no participating campaign on this
  // order is sponsorType: 'platform'.
  @Prop({ default: 0 })
  platformSponsoredDiscountTotal: number;

  // Copied from Checkout at placeOrder — which promotional banner (if any)
  // the buyer clicked through before this order, for promotion analytics'
  // conversions/revenue attribution. Same convention as couponCode above.
  // See Checkout.attributedBannerId/attributedStoreBannerId for why these are
  // never a PromotionRequest id directly.
  @Prop({ type: String, default: null })
  attributedBannerId: string | null;

  @Prop({ type: String, default: null })
  attributedStoreBannerId: string | null;

  @Prop({ required: true })
  totalAmount: number;

  // 'safepay'/'jazzcash'/'easypaisa'/'payfast' added for the per-store
  // integrations module (src/integrations) — purely additive, every
  // existing order's value is untouched.
  @Prop({
    enum: [
      'cash_on_delivery',
      'stripe',
      'manual_bank_transfer',
      'safepay',
      'jazzcash',
      'easypaisa',
      'payfast',
    ],
    required: true,
  })
  paymentType: string;

  // 'pending_verification' — manual bank-transfer order awaiting an admin to
  // review the buyer's uploaded proof (see manual-payments module). Never
  // set for stripe/COD orders. 'partially_paid' — real "Record payments"
  // ledger (OrdersService.recordOrderPayment) has recorded SOME but not yet
  // the full order total; flips to 'paid' automatically once fully covered.
  @Prop({ enum: ['unpaid', 'pending_verification', 'partially_paid', 'paid', 'failed', 'refunded'], default: 'unpaid' })
  paymentStatus: string;

  @Prop({ default: false })
  isPaid: boolean;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  // Real Shopify-equivalent payment terms — carried over from a Draft Order
  // that had them set (DraftOrder.paymentTerms/dueDate). Null for every
  // buyer-checkout order (payment terms only ever apply to a manually
  // created merchant order).
  @Prop({ type: String, enum: ['due_on_receipt', 'net_15', 'net_30', 'net_60', null], default: null })
  paymentTerms: 'due_on_receipt' | 'net_15' | 'net_30' | 'net_60' | null;

  @Prop({ type: Date, default: null })
  dueDate: Date | null;

  // Real overdue-payment dunning dedup — set once
  // OrdersService.sendOverdueOrderReminders notifies the seller this
  // order's `dueDate` has passed while still unpaid, so the same order
  // never re-notifies on every subsequent daily cron tick.
  @Prop({ type: Date, default: null })
  overdueReminderSentAt: Date | null;

  // Overall derived status — see `order-status.util.ts#deriveOrderStatus`,
  // the ONE function that computes this value from `sellerOrders[].status`;
  // never hand-set independently. Shares its exact enum with
  // `SellerOrder.status` above (both are rolled up by the same function, at
  // different levels) — `shipped`/`delivered`/`refunded`/
  // `partially_cancelled`/`partially_refunded` are new here: this enum
  // previously had no way to represent those real states at all (a
  // structural gap the buyer-facing order timeline already silently
  // depended on `orderStatus` being able to reach `'shipped'`/`'delivered'`,
  // which it never actually could before this change).
  @Prop({
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
      'partially_cancelled',
      'partially_refunded',
      'partially_shipped',
    ],
    default: 'pending',
  })
  orderStatus: string;

  @Prop({ default: false })
  hasReturnApproved!: boolean;

  // Copied from Checkout.attributionSource at order-creation time — see
  // that field's comment for why this can only ever be client-reported.
  // Absent on every order created before this field existed (never
  // backfilled — analytics must treat missing/'other' as "unknown", not zero).
  @Prop({
    type: String,
    enum: [
      'marketplace_search',
      'direct_link',
      'social_media',
      'email',
      'other',
    ],
    default: 'other',
  })
  attributionSource: string;

  @Prop({ default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ orderNumber: 1 }, { unique: true });
OrderSchema.index({ userId: 1 });
OrderSchema.index({ attributionSource: 1 });
OrderSchema.index({ checkoutId: 1 });
OrderSchema.index({ 'sellerOrders.sellerId': 1, 'sellerOrders.status': 1 });
OrderSchema.index({ 'sellerOrders.storeId': 1 });
OrderSchema.index({ 'sellerOrders.items.status': 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ createdAt: -1 });
// Every analytics aggregation (order-aggregation.util.ts#sellerOrderMatchStage,
// and every direct orderModel.aggregate() call in admin-analytics/analytics)
// leads with `{ isDelete: false, createdAt: { $gte, $lte } }` as its very
// first $match — a lone `createdAt` index still has to fall back to an
// in-memory filter for `isDelete` on every candidate document. Compound here
// (isDelete first, since it's the equality predicate) lets that first $match
// be satisfied by the index alone.
OrderSchema.index({ isDelete: 1, createdAt: -1 });
