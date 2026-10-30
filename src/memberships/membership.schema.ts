import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type AccessPlanDocument = AccessPlan & Document;
export type MemberSubscriptionDocument = MemberSubscription & Document;

@Schema({ timestamps: true, collection: 'accessplans' })
export class AccessPlan {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: String, default: '', maxlength: 1000 }) description: string;
  @Prop({ type: String, enum: ['free', 'one_time', 'recurring'], required: true }) type: string;
  @Prop({ type: Number, default: 0, min: 0 }) amount: number; // in the store currency
  @Prop({ type: String, default: 'USD' }) currency: string;
  @Prop({ type: String, enum: ['week', 'month', 'year'], default: 'month' }) interval: string;
  @Prop({ type: Number, default: 1, min: 1, max: 12 }) intervalCount: number;
  @Prop({ type: Number, default: 0, min: 0, max: 365 }) trialDays: number;
  @Prop({ type: Number, default: null }) fixedLength: number | null; // number of periods; null = until cancelled
  @Prop({ default: false }) pauseAllowed: boolean;
  @Prop({ type: [String], default: [] }) benefits: string[];
  @Prop({ type: Number, default: 1 }) tier: number; // higher tier includes the lower ones
  @Prop({ type: Number, default: 0, min: 0, max: 7 }) graceDays: number;
  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: string;
  // A digital product of this store that sells the plan: buying it through the normal checkout (the seller's own
  // payment methods) starts or renews the membership. Solvexo never handles the money.
  @Prop({ type: String, default: null }) productId: string | null;
}
export const AccessPlanSchema = SchemaFactory.createForClass(AccessPlan);
AccessPlanSchema.index({ storeId: 1, status: 1, tier: 1 });

@Schema({ timestamps: true, collection: 'membersubscriptions' })
export class MemberSubscription {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) customerId: string;
  @Prop({ required: true }) planId: string;
  @Prop({ type: String, default: null }) pendingPlanId: string | null; // downgrade applied at period end
  @Prop({ type: String, enum: ['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'], required: true }) status: string;
  @Prop({ type: Boolean, default: false }) awaitingFirstPayment: boolean;
  @Prop({ type: Date, default: null }) currentPeriodStart: Date | null;
  @Prop({ type: Date, default: null }) currentPeriodEnd: Date | null; // null = no end (free / one-time)
  @Prop({ type: Date, default: null }) dueAt: Date | null; // set while past_due
  @Prop({ type: Boolean, default: false }) cancelAtPeriodEnd: boolean;
  @Prop({ type: Number, default: 0 }) periodsPaid: number;
  @Prop({ type: Number, default: 0 }) failedCount: number; // reminders / retries already sent
  @Prop({ type: Date, default: null }) pausedAt: Date | null;
  @Prop({ type: Date, default: null }) reminderSentFor: Date | null; // currentPeriodEnd a 7-day reminder was sent for
  @Prop({ type: String, enum: ['manual', 'stripe', 'safepay'], default: 'manual' }) provider: string;
  @Prop({ type: String, default: null }) providerSubscriptionId: string | null;
  @Prop({ type: String, default: null }) providerCustomerId: string | null;
  @Prop({ type: [String], default: [] }) appliedItemIds: string[]; // paid order items already counted (idempotent)
  @Prop({ type: Number, default: 0 }) amountDue: number; // upgrade difference the seller still has to collect
  @Prop({ type: [{ at: Date, action: String, by: String, note: String, _id: false }], default: [] })
  audit: { at: Date; action: string; by: string; note: string }[];
}
export const MemberSubscriptionSchema = SchemaFactory.createForClass(MemberSubscription);
MemberSubscriptionSchema.index({ storeId: 1, customerId: 1, status: 1 });
MemberSubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });
// one live membership per customer per plan
MemberSubscriptionSchema.index(
  { storeId: 1, customerId: 1, planId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['trialing', 'active', 'past_due', 'paused'] } } },
);
