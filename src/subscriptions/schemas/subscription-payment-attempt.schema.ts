/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionPaymentAttemptDocument = SubscriptionPaymentAttempt & Document;

/**
 * One row per charge attempt (renewal, initial subscribe, or proration).
 * This is the dunning/retry audit trail admin uses to inspect payment
 * failures — kept as its own collection (not embedded) so it can be
 * queried/paginated platform-wide without loading full subscription docs.
 */
@Schema({ timestamps: true })
export class SubscriptionPaymentAttempt {
  @Prop({ type: String, required: true }) subscriptionId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) customerId: string;

  // 1-based, monotonically increasing per subscription
  @Prop({ type: Number, required: true }) attemptNumber: number;

  @Prop({ type: String, enum: ['initial', 'renewal', 'proration'], required: true }) attemptType: string;
  @Prop({ type: String, enum: ['success', 'failed'], required: true }) outcome: string;

  @Prop({ type: Number, required: true }) amountUSD: number;
  @Prop({ type: String, default: null }) failureReason: string | null;
  // Stripe decline code (e.g. 'insufficient_funds', 'card_declined') — powers
  // dunning analytics segmentation beyond a free-text reason string.
  @Prop({ type: String, default: null }) failureCode: string | null;

  @Prop({ type: String, default: null }) invoiceId: string | null;
  @Prop({ type: String, default: null }) providerChargeId: string | null;
  @Prop({ type: String, default: null }) stripePaymentIntentId: string | null;
}

export const SubscriptionPaymentAttemptSchema = SchemaFactory.createForClass(SubscriptionPaymentAttempt);
SubscriptionPaymentAttemptSchema.index({ subscriptionId: 1, createdAt: -1 });
SubscriptionPaymentAttemptSchema.index({ storeId: 1, createdAt: -1 });
SubscriptionPaymentAttemptSchema.index({ outcome: 1, createdAt: -1 });
SubscriptionPaymentAttemptSchema.index({ failureCode: 1, createdAt: -1 });
