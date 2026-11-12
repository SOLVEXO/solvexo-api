/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LoyaltyProgramDocument = LoyaltyProgram & Document;

@Schema({ _id: false })
export class LoyaltyTier {
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) minPoints: number;
  @Prop({ type: [String], default: [] }) benefits: string[];
}
export const LoyaltyTierSchema = SchemaFactory.createForClass(LoyaltyTier);

@Schema({ timestamps: true })
export class LoyaltyProgram {
  @Prop({ required: true, unique: true })
  storeId: string;

  @Prop({ type: Boolean, default: false })
  isEnabled: boolean;

  // ── Earning rules ──
  @Prop({ type: Number, default: 1 })
  pointsPerDollar: number;

  @Prop({ type: Number, default: 0 })
  pointsPerReview: number;

  @Prop({ type: Number, default: 0 })
  pointsPerReferral: number;

  @Prop({ type: Number, default: 0 })
  birthdayBonusPoints: number;

  // ── At the till (G3.3, D2) — integers only, in MINOR units of the store currency; null = off ──
  /** spend (minor units, net of discount and tax) that earns ONE point at the till: points = floor(netSpendMinor / this) */
  @Prop({ type: Number, default: null })
  posEarnSpendMinor: number | null;

  /** what ONE point is worth when redeemed at the till, in minor units (the discount = points × this) */
  @Prop({ type: Number, default: null })
  posRedeemMinorPerPoint: number | null;

  // null = points never expire
  @Prop({ type: Number, default: null })
  pointsExpiryMonths: number | null;

  // sorted ascending by minPoints — lowest tier first
  @Prop({ type: [LoyaltyTierSchema], default: [] })
  tiers: LoyaltyTier[];
}

export const LoyaltyProgramSchema = SchemaFactory.createForClass(LoyaltyProgram);
