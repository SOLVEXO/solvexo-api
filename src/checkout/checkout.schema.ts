import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CheckoutDocument = Checkout & Document;

@Schema({ _id: false })
export class CheckoutItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  variantId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  // snapshot fields
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: String, default: null })
  size: string | null;

  @Prop({ type: String, default: null })
  color: string | null;

  @Prop({ type: String, default: null })
  licenseType: string | null;

  @Prop({ required: true })
  quantity: number;

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
}

export const CheckoutItemSchema = SchemaFactory.createForClass(CheckoutItem);

@Schema({ timestamps: true })
export class Checkout {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, default: null })
  addressId: string | null;

  @Prop({ type: String, default: 'USD' })
  currency: string;

  @Prop({ type: [CheckoutItemSchema], default: [] })
  items: CheckoutItem[];

  @Prop({ type: String, default: null })
  shippingZoneId: string | null;

  @Prop({ type: String, enum: ['cash_on_delivery', 'stripe'], default: null })
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

  // Coupon (seller store coupon OR platform-wide coupon) applied at checkout
  // time via CheckoutService.applyCoupon — distinct from subscriberSavingsUSD,
  // which is a membership benefit, not a code the buyer typed in.
  @Prop({ type: String, default: null })
  couponCode: string | null;

  @Prop({ default: 0 })
  couponDiscountUSD: number;

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
    enum: ['marketplace_search', 'direct_link', 'social_media', 'email', 'other'],
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