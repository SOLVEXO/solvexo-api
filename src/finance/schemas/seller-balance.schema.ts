import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SellerBalanceDocument = SellerBalance & Document;

@Schema({ timestamps: true })
export class SellerBalance {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // Funds available for immediate payout
  @Prop({ type: Number, default: 0 }) availableBalance: number;
  // Funds from recent sales still in clearing period (3 days)
  @Prop({ type: Number, default: 0 }) pendingBalance: number;

  // Lifetime totals
  @Prop({ type: Number, default: 0 }) totalRevenue: number;
  @Prop({ type: Number, default: 0 }) totalFees: number;
  @Prop({ type: Number, default: 0 }) totalRefunds: number;
  @Prop({ type: Number, default: 0 }) totalPayouts: number;

  @Prop({ type: String, default: 'USD' }) currency: string;

  // Set when a refund/chargeback reversal drove available or pending balance
  // negative (typically because the seller already withdrew before the
  // refund/dispute landed) — the negative balance itself IS the debt; this
  // flag just makes it visible to admins without them having to notice a
  // negative number buried in a balance list. Cleared automatically once a
  // later credit (new sale, rejected-payout reversal, etc.) brings both
  // balances back to >= 0.
  @Prop({ type: Boolean, default: false }) isFlaggedForReview: boolean;
  @Prop({ type: String, default: null }) flaggedReason: string | null;
  @Prop({ type: Date, default: null }) flaggedAt: Date | null;
}

export const SellerBalanceSchema = SchemaFactory.createForClass(SellerBalance);
// Compound (not just storeId) — a store can hold a balance in more than one
// currency (e.g. USD from Stripe sales, PKR from Pakistan manual-transfer
// sales), each cleared/paid-out independently.
SellerBalanceSchema.index({ storeId: 1, currency: 1 }, { unique: true });
SellerBalanceSchema.index({ sellerId: 1 });
SellerBalanceSchema.index({ isFlaggedForReview: 1 });
