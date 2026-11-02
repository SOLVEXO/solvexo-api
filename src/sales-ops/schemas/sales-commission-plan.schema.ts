/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesCommissionPlanDocument = SalesCommissionPlan & Document;

/** How a partner is paid. Each partner has one plan; plans can be shared. See commission.util.ts for the rules. */
@Schema({ timestamps: true, collection: 'sales_commission_plans' })
export class SalesCommissionPlan {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, default: null }) description: string | null;
  /** One-time PKR per new paying merchant. */
  @Prop({ type: Number, default: null }) bountyPKR: number | null;
  /** % of what the merchant pays Solvexo (before tax, after refunds). */
  @Prop({ type: Number, default: null }) percent: number | null;
  /** Months after the merchant's first payment the % applies; null = for as long as they pay. */
  @Prop({ type: Number, default: 12 }) percentMonths: number | null;
  @Prop({ type: [{ minPaying: Number, percent: Number }], default: [] })
  tiers: { minPaying: number; percent: number }[];
  /** Days before an amount can be paid out (the refund window). */
  @Prop({ type: Number, default: 14 }) holdDays: number;
  /** Smallest payout worth sending. */
  @Prop({ type: Number, default: 0 }) minPayoutPKR: number;
  @Prop({ type: Boolean, default: false }) isArchived: boolean;
}

export const SalesCommissionPlanSchema =
  SchemaFactory.createForClass(SalesCommissionPlan);
