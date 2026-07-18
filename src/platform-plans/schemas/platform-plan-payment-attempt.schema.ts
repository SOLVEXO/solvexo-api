/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformPlanPaymentAttemptDocument = PlatformPlanPaymentAttempt & Document;

/** Dunning/retry audit trail for platform-plan billing — mirrors SubscriptionPaymentAttempt. */
@Schema({ timestamps: true })
export class PlatformPlanPaymentAttempt {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: Number, required: true }) attemptNumber: number;
  @Prop({ type: String, enum: ['initial', 'renewal', 'proration'], required: true }) attemptType: string;
  @Prop({ type: String, enum: ['success', 'failed'], required: true }) outcome: string;

  @Prop({ type: Number, required: true }) amountUSD: number;
  @Prop({ type: String, default: null }) failureReason: string | null;
  @Prop({ type: String, default: null }) failureCode: string | null;

  @Prop({ type: String, default: null }) invoiceId: string | null;
  @Prop({ type: String, default: null }) providerChargeId: string | null;
}

export const PlatformPlanPaymentAttemptSchema = SchemaFactory.createForClass(PlatformPlanPaymentAttempt);
PlatformPlanPaymentAttemptSchema.index({ storeId: 1, createdAt: -1 });
PlatformPlanPaymentAttemptSchema.index({ outcome: 1, createdAt: -1 });
