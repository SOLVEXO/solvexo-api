/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionCreditWalletDocument = SubscriptionCreditWallet & Document;

/**
 * Fulfills the `credits` plan-benefit type (previously accepted on
 * `PlanBenefitDto` but never enforced anywhere). One wallet per
 * customer+store+creditType; granted `creditsPerCycle` units on every
 * successful renewal/initial charge, spendable via `spend()` against
 * digital-download or service-booking redemption flows.
 */
@Schema({ timestamps: true })
export class SubscriptionCreditWallet {
  @Prop({ type: String, required: true }) customerId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) subscriptionId: string;
  @Prop({ type: String, enum: ['download', 'service'], required: true }) creditType: string;

  @Prop({ type: Number, default: 0 }) balance: number;
  @Prop({ type: Number, default: 0 }) totalGranted: number;
  @Prop({ type: Number, default: 0 }) totalSpent: number;

  @Prop({
    type: [Object], default: [],
  })
  ledger: Array<{
    type: 'grant' | 'spend' | 'expire';
    amount: number;
    balanceAfter: number;
    reason: string;
    referenceId: string | null;
    createdAt: Date;
  }>;
}

export const SubscriptionCreditWalletSchema = SchemaFactory.createForClass(SubscriptionCreditWallet);
SubscriptionCreditWalletSchema.index({ customerId: 1, storeId: 1, creditType: 1 }, { unique: true });
SubscriptionCreditWalletSchema.index({ subscriptionId: 1 });
