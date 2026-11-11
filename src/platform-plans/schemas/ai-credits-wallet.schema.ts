/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AiCreditsWalletDocument = AiCreditsWallet & Document;

/**
 * Store-scoped AI credit balance, spent by AI Studio and the AI SEO suggestions (AiCreditsService owns the rules).
 * `balance` is everything the store can spend now; `bonusBalance` is the part of it the seller BOUGHT (kept at the monthly reset).
 */
@Schema({ timestamps: true })
export class AiCreditsWallet {
  @Prop({ type: String, required: true, unique: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: Number, default: 0 }) balance: number;
  @Prop({ type: Number, default: 0 }) monthlyAllowance: number; // from the store's current PlatformPlan
  @Prop({ type: Number, default: 0 }) bonusBalance: number; // bought credits still unspent (a part of `balance`)
  @Prop({ type: Date, default: null }) lastResetAt: Date | null;

  @Prop({ type: [Object], default: [] }) ledger: Array<{
    type: 'grant' | 'spend' | 'reset' | 'purchase';
    amount: number; balanceAfter: number; reason: string; createdAt: Date;
  }>;
}

export const AiCreditsWalletSchema = SchemaFactory.createForClass(AiCreditsWallet);
AiCreditsWalletSchema.index({ storeId: 1 }, { unique: true });
