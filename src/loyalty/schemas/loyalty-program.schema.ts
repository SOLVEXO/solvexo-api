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

  // null = points never expire
  @Prop({ type: Number, default: null })
  pointsExpiryMonths: number | null;

  // sorted ascending by minPoints — lowest tier first
  @Prop({ type: [LoyaltyTierSchema], default: [] })
  tiers: LoyaltyTier[];
}

export const LoyaltyProgramSchema = SchemaFactory.createForClass(LoyaltyProgram);
