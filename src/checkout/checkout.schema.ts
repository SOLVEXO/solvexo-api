import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { FxSnapshot, FxSnapshotSchema } from '../exchange-rate/schemas/exchange-rate.schema';

export type CheckoutDocument = Checkout & Document;

@Schema({ _id: false })
export class CheckoutItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  variantId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, default: null })
  sellerName: string | null;

  @Prop({ type: Boolean, default: false })
  sellerVerified: boolean;

  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  // Product's own category (educational collapses into `type: 'digital'` above
  // for fulfillment) — carried through to the placed Order so history/labels
  // can distinguish it later.
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

  // The currency `price`/`totalPrice` below are denominated in — this
  // item's OWNING SELLER'S Store.baseCurrency at the moment it was added to
  // this checkout, independent of the buyer's chosen checkout currency
  // above. A mixed-seller cart can have items in different native
  // currencies; each is converted into the checkout currency individually
  // (see CheckoutService.createCheckout) rather than summed raw. Nullable
  // only so checkouts created before this field existed remain readable —
  // those predate any real seller-currency distinction (implicitly 'USD').
  @Prop({ type: String, default: null })
  currency: string | null;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;

  // Set only when a subscriber discount was applied server-side. `price`/
  // `totalPrice` above already reflect the discounted amount — these are
  // kept for receipt display ("you saved $X") and analytics.
  @Prop({ type: Number, default: null })
  originalPrice: number | null;

  @Prop({ type: Number, default: 0 })
  subscriberDiscountUSD: number;

  // Coupon discount allocated to this line (only set for items belonging to
  // the coupon's store — see CheckoutService.applyCoupon). `price`/
  // `totalPrice` above already reflect the discount; these two "before"
  // fields are the pre-coupon baseline so removing/replacing a coupon can
  // cleanly revert without compounding.
  @Prop({ type: Number, default: 0 })
  couponDiscountUSD: number;

  @Prop({ type: Number, default: null })
  priceBeforeCoupon: number | null;

  @Prop({ type: Number, default: null })
  totalPriceBeforeCoupon: number | null;

  // Automatic platform-campaign discount (see MarketingService's active-campaign
  // lookup) — resolved once at checkout-creation time from the item's store's
  // active campaign, same "computed server-side, never client-supplied" rule as
  // subscriberDiscountUSD. `price`/`totalPrice` above already reflect it.
  @Prop({ type: String, default: null })
  campaignId: string | null;

  @Prop({ type: Number, default: 0 })
  campaignDiscountUSD: number;

  // Who bears campaignDiscountUSD's cost — see Campaign.sponsorType. Carried
  // onto the placed Order so PaymentService/OrdersService know, without a
  // lookup, whether to restore the seller's payout for this line.
  @Prop({ type: String, enum: ['seller', 'platform'], default: null })
  campaignSponsorType: 'seller' | 'platform' | null;
}

export const CheckoutItemSchema = SchemaFactory.createForClass(CheckoutItem);

@Schema({ timestamps: true })
export class Checkout {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, default: null })
  addressId: string | null;

  // The currency the buyer is actually being charged in — server-resolved
  // and validated at checkout creation (CheckoutService.createCheckout)
  // against the buyer's currencyPreference, never client-trusted beyond
  // that validation. No schema-level default anymore: every NEW checkout
  // must set this explicitly. Existing pre-migration checkouts (which relied
  // on the old implicit 'USD' default) are transient/expired documents and
  // are left exactly as they were written — never touched by this change.
  @Prop({ type: String })
  currency: string;

  // One entry per distinct currency actually involved in this checkout (the
  // checkout currency itself, plus every seller/store currency present
  // among `items`) — immutable the instant this document is created.
  // Refunds and seller settlement replay these exact rates; they never
  // re-read today's ExchangeRate table. Absent on any checkout created
  // before this field existed.
  @Prop({ type: [FxSnapshotSchema], default: [] })
  fxSnapshots: FxSnapshot[];

  @Prop({ type: [CheckoutItemSchema], default: [] })
  items: CheckoutItem[];

  @Prop({ type: String, default: null })
  shippingZoneId: string | null;

  @Prop({ type: String, enum: ['cash_on_delivery', 'stripe', 'manual_bank_transfer'], default: null })
  paymentType: string | null;

  @Prop({ type: String, default: null })
  paymentMethodId: string | null;

  @Prop({ default: 0 })
  subtotal: number;

  @Prop({ default: 0 })
  shippingFee: number;

  @Prop({ default: 0 })
  taxAmount: number;

  // Total subscriber-benefit savings applied server-side (line-item discounts
  // + shipping waiver). Shown to the buyer as "you saved $X with your membership".
  @Prop({ default: 0 })
  subscriberSavingsUSD: number;

  // Store-scoped coupon applied via CheckoutService.applyCoupon — a coupon
  // only ever discounts the items belonging to its own store, even in a
  // multi-store cart. `couponStoreId` records which store's items the
  // discount was distributed across (see CheckoutItem.couponDiscountUSD).
  // Distinct from subscriberSavingsUSD, which is a membership benefit, not
  // a code the buyer typed in.
  @Prop({ type: String, default: null })
  couponCode: string | null;

  @Prop({ type: String, default: null })
  couponStoreId: string | null;

  @Prop({ default: 0 })
  couponDiscountTotalUSD: number;

  // Sum of every item's campaignDiscountUSD — a multi-store cart can have a
  // different active campaign per store, so (unlike couponCode/couponStoreId)
  // there's no single "the" campaign at the checkout level, only this total.
  @Prop({ default: 0 })
  campaignDiscountTotalUSD: number;

  // Set client-side from whichever promotional banner the buyer clicked
  // through (localStorage attribution token, short TTL) — copied onto the
  // resulting Order(s) at placeOrder so promotion analytics can attribute
  // conversions/revenue, same convention as couponCode above. `attributedBannerId`
  // covers the platform `Banner` collection (admin-authored AND
  // PromotionRequest-derived banners are both stored there, same id space);
  // `attributedStoreBannerId` covers a seller's own `StoreBanner`. Never a
  // PromotionRequest id directly — buyers never see/click that document,
  // only the Banner row it produces once approved+paid.
  @Prop({ type: String, default: null })
  attributedBannerId: string | null;

  @Prop({ type: String, default: null })
  attributedStoreBannerId: string | null;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({
    type: String,
    enum: ['pending', 'payment_pending', 'completed', 'expired', 'cancelled'],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date, default: null })
  expiredAt: Date | null;

  // Marketing attribution — client-reported (mobile app has no meaningful
  // Referer/UTM headers), captured at checkout-creation time and copied onto
  // the resulting Order(s) for analytics. Defaults to 'other' when the
  // client doesn't send one; never inferred/fabricated server-side.
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
}

export const CheckoutSchema = SchemaFactory.createForClass(Checkout);

CheckoutSchema.index({ userId: 1 });
CheckoutSchema.index({ status: 1 });
CheckoutSchema.index({ createdAt: -1 });
CheckoutSchema.index({ 'items.sellerId': 1 });
CheckoutSchema.index({ 'items.storeId': 1 });
