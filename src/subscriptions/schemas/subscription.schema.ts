/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionDocument = Subscription & Document;

@Schema({ timestamps: true })
export class Subscription {
  @Prop({ type: String, required: true }) planId: string;
  @Prop({ type: String, required: true }) customerId: string;
  @Prop({ type: String, required: true }) sellerId: string; // denormalized for fast seller queries

  @Prop({ type: String, enum: ['monthly', 'yearly'], required: true }) billingInterval: string;

  // Snapshot of USD price at subscription time. Plan price changes never retroactively affect this.
  @Prop({ type: Number, required: true }) amountUSD: number;

  @Prop({
    type: String,
    enum: ['active', 'paused', 'canceled', 'past_due'],
    default: 'active',
  })
  status: string;

  @Prop({ type: Date, required: true }) startedAt: Date;
  @Prop({ type: Date, required: true }) currentPeriodStart: Date;
  @Prop({ type: Date, required: true }) currentPeriodEnd: Date;
  @Prop({ type: Date, required: true }) nextBillingDate: Date;

  @Prop({ type: Date, default: null }) canceledAt: Date | null;
  @Prop({ type: Date, default: null }) pausedAt: Date | null;

  // Running total of all successfully charged amounts in USD
  @Prop({ type: Number, default: 0 }) totalPaidUSD: number;

  @Prop({ type: String, enum: ['manual', 'stripe'], default: 'manual' }) paymentProvider: string;
  // Will hold the Stripe subscription ID once integrated; null for manual provider
  @Prop({ type: String, default: null }) providerSubscriptionId: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);
SubscriptionSchema.index({ sellerId: 1, status: 1 });
SubscriptionSchema.index({ sellerId: 1, createdAt: -1 });
SubscriptionSchema.index({ customerId: 1 });
SubscriptionSchema.index({ planId: 1 });
SubscriptionSchema.index({ nextBillingDate: 1, status: 1 }); // for billing jobs
