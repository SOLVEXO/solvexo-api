/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { StorePlan } from '../../store/schemas/store.schema';

export type PlatformSubscriptionDocument = PlatformSubscription & Document;

@Schema({ _id: false })
export class PosAddon {
  @Prop({ type: Boolean, default: false }) active: boolean;
  @Prop({ type: Date, default: null }) activatedAt: Date | null;
  @Prop({ type: Date, default: null }) nextBillingDate: Date | null;
  @Prop({ type: Number, default: 0 }) failedPaymentAttempts: number;
  @Prop({ type: Date, default: null }) canceledAt: Date | null;
}
export const PosAddonSchema = SchemaFactory.createForClass(PosAddon);

/**
 * One document per STORE (not per seller — a seller can own multiple stores,
 * each with its own platform tier). Mirrors the dunning/proration fields of
 * `src/subscriptions/schemas/subscription.schema.ts` so the exact same
 * billing-cron pattern applies here.
 */
@Schema({ timestamps: true })
export class PlatformSubscription {
  @Prop({ type: String, required: true, unique: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string; // denormalized for seller-wide queries

  @Prop({ type: String, enum: Object.values(StorePlan), required: true }) tier: StorePlan;
  @Prop({ type: String, enum: ['monthly', 'yearly'], required: true }) billingInterval: string;
  @Prop({ type: Number, required: true }) amountUSD: number; // snapshot at subscribe/change time

  @Prop({
    type: String,
    enum: ['active', 'past_due', 'canceled'],
    default: 'active',
  })
  status: string;

  @Prop({ type: Date, required: true }) currentPeriodStart: Date;
  @Prop({ type: Date, required: true }) currentPeriodEnd: Date;
  @Prop({ type: Date, required: true }) nextBillingDate: Date;
  @Prop({ type: Date, default: null }) canceledAt: Date | null;

  @Prop({ type: Number, default: 0 }) failedPaymentAttempts: number;
  @Prop({ type: Number, default: 0 }) creditBalanceUSD: number;

  @Prop({ type: [Object], default: [] }) tierHistory: Array<{
    fromTier: StorePlan; toTier: StorePlan; changedAt: Date;
  }>;

  @Prop({ type: PosAddonSchema, default: () => ({}) }) posAddon: PosAddon;

  @Prop({ type: String, enum: ['manual', 'stripe'], default: 'manual' }) paymentProvider: string;
  @Prop({ type: String, default: null }) providerSubscriptionId: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const PlatformSubscriptionSchema = SchemaFactory.createForClass(PlatformSubscription);
PlatformSubscriptionSchema.index({ storeId: 1 }, { unique: true });
PlatformSubscriptionSchema.index({ sellerId: 1 });
PlatformSubscriptionSchema.index({ status: 1 });
PlatformSubscriptionSchema.index({ nextBillingDate: 1, status: 1 }); // for billing jobs
