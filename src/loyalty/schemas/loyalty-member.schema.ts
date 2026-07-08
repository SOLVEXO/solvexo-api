/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type LoyaltyMemberDocument = LoyaltyMember & Document;

@Schema({ timestamps: true })
export class LoyaltyMember {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ type: Number, default: 0 })
  pointsBalance: number;

  // never decreases on redeem — used purely to compute tier
  @Prop({ type: Number, default: 0 })
  lifetimePoints: number;

  @Prop({ type: String, default: null })
  currentTier: string | null;

  @Prop({ type: Date, default: Date.now })
  lastActivityAt: Date;
}

export const LoyaltyMemberSchema = SchemaFactory.createForClass(LoyaltyMember);

LoyaltyMemberSchema.index({ storeId: 1, userId: 1 }, { unique: true });
LoyaltyMemberSchema.index({ storeId: 1, lastActivityAt: 1 });
