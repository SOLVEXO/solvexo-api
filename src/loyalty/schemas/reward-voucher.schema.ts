import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RewardVoucherDocument = RewardVoucher & Document;

/**
 * Issued by LoyaltyService.redeemReward — closes the loop the reward catalog
 * previously left open: points were spent and a LoyaltyTransaction was
 * written, but nothing let the buyer actually claim the reward's real-world
 * benefit. One voucher = one redemption, single-use, redeemable only by the
 * member who earned it, at checkout (see CheckoutService.applyCoupon, which
 * falls back to a RewardVoucher lookup when the typed code isn't a Coupon).
 */
@Schema({ timestamps: true })
export class RewardVoucher {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  rewardId: string;

  @Prop({ required: true, uppercase: true, trim: true })
  code: string;

  @Prop({ required: true, enum: ['fixed_discount', 'free_product'] })
  type: 'fixed_discount' | 'free_product';

  // Denominated in the issuing store's own baseCurrency (mirrors Coupon.currency's
  // seller-scope convention) — captured at redemption time so a later reward-catalog
  // edit can never change the value of an already-issued voucher.
  @Prop({ type: Number, default: null })
  discountValue: number | null;

  @Prop({ type: String, default: null })
  productId: string | null;

  @Prop({ type: String, enum: ['active', 'used', 'expired'], default: 'active' })
  status: 'active' | 'used' | 'expired';

  @Prop({ type: String, default: null })
  checkoutId: string | null;

  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ type: Date, default: null })
  usedAt: Date | null;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const RewardVoucherSchema = SchemaFactory.createForClass(RewardVoucher);

RewardVoucherSchema.index({ storeId: 1, code: 1 }, { unique: true });
RewardVoucherSchema.index({ userId: 1, status: 1 });
