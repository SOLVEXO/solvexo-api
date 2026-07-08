/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LoyaltyTransactionDocument = LoyaltyTransaction & Document;

export const LOYALTY_TRANSACTION_TYPES = [
  'purchase',   // earned from a completed order
  'review',     // earned from a verified-purchase review
  'referral',   // earned from a successful referral (awarded manually until an affiliate/referral system exists)
  'birthday',   // birthday bonus (awarded manually until birthdate collection exists)
  'redeem',     // spent on a reward
  'expire',     // removed by the points-expiry job
  'adjustment', // manual credit/debit by the seller
] as const;
export type LoyaltyTransactionType = (typeof LOYALTY_TRANSACTION_TYPES)[number];

@Schema({ timestamps: true })
export class LoyaltyTransaction {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  memberId: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true, enum: LOYALTY_TRANSACTION_TYPES })
  type: LoyaltyTransactionType;

  // positive = earned, negative = redeemed/expired/debited
  @Prop({ required: true })
  points: number;

  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ required: true })
  balanceAfter: number;

  @Prop({ type: String, default: null })
  description: string | null;
}

export const LoyaltyTransactionSchema = SchemaFactory.createForClass(LoyaltyTransaction);

LoyaltyTransactionSchema.index({ storeId: 1, createdAt: -1 });
LoyaltyTransactionSchema.index({ memberId: 1, createdAt: -1 });
LoyaltyTransactionSchema.index({ storeId: 1, type: 1 });
