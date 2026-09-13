import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AffiliateDocument = Affiliate & Document;

/** One row per person a seller has added to their store's affiliate
 *  program — added directly by the seller (name + email), same UX as
 *  real affiliate apps like Refersion/UpPromote, not a public self-serve
 *  signup flow. `userId` is populated automatically when the email matches
 *  an existing platform account, but is never required — an affiliate
 *  doesn't need a Solvexo account to hold a referral code and earn a
 *  commission (their payout happens outside the platform, same as how a
 *  seller's own Payout is seller-initiated rather than automatic). */
@Schema({ timestamps: true })
export class Affiliate {
  @Prop({ required: true })
  storeId: string;

  @Prop({ type: String, default: null })
  userId: string | null;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, lowercase: true, trim: true })
  email: string;

  // Short, URL-safe, globally unique — embedded in the referral link as
  // /api/affiliate/r/:referralCode (see AffiliateController.trackClick).
  @Prop({ required: true, unique: true })
  referralCode: string;

  // Null = inherit the store's AffiliateProgram rate. Set only when a
  // seller negotiates a one-off rate with a specific affiliate (a real,
  // common case — "our top affiliate gets 15% instead of the standard 10%").
  @Prop({ type: String, enum: ['percentage', 'fixed', null], default: null })
  commissionType: 'percentage' | 'fixed' | null;

  @Prop({ type: Number, default: null })
  commissionValue: number | null;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0 })
  totalClicks: number;

  @Prop({ type: Number, default: 0 })
  totalConversions: number;

  @Prop({ type: Number, default: 0 })
  totalEarningsUSD: number;

  @Prop({ type: Number, default: 0 })
  totalPaidUSD: number;

  @Prop({ default: false })
  isDelete: boolean;
}

export const AffiliateSchema = SchemaFactory.createForClass(Affiliate);
AffiliateSchema.index({ storeId: 1, createdAt: -1 });
AffiliateSchema.index({ referralCode: 1 }, { unique: true });
