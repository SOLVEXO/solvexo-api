import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AffiliateReferralDocument = AffiliateReferral & Document;

/** One row per order attributed to an affiliate's referral code — created
 *  once at order-placement time by AffiliateService.recordConversion
 *  (called from PaymentService.createOrder, same convention as the
 *  Banner/StoreBanner attribution block right above that call). The
 *  commission amount is a snapshot computed at that moment from whichever
 *  rate applied then (the affiliate's own override or the program's rate)
 *  — never recomputed later even if the program's rate subsequently
 *  changes, same "snapshot at the moment it happened" principle as
 *  SellerOrder.settlementAmount.
 *
 *  Scope note: unlike GiftCardTransaction, this has no automatic reversal
 *  hook on order cancellation/refund — `payAffiliate` is a manual,
 *  deliberate seller action (there is no automatic payout), so the seller
 *  is expected to review for refunds before marking a referral paid, the
 *  same manual diligence a seller already applies to any payout. */
@Schema({ timestamps: true })
export class AffiliateReferral {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  affiliateId: string;

  @Prop({ required: true })
  checkoutId: string;

  @Prop({ required: true })
  orderId: string;

  @Prop({ required: true })
  orderRevenueUSD: number;

  @Prop({ required: true })
  commissionUSD: number;

  @Prop({ type: String, enum: ['pending', 'paid'], default: 'pending' })
  status: 'pending' | 'paid';

  @Prop({ type: Date, default: null })
  paidAt: Date | null;
}

export const AffiliateReferralSchema = SchemaFactory.createForClass(AffiliateReferral);
AffiliateReferralSchema.index({ storeId: 1, createdAt: -1 });
AffiliateReferralSchema.index({ affiliateId: 1, status: 1 });
