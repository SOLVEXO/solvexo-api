/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionPlanDocument = SubscriptionPlan & Document;

@Schema({ timestamps: true })
export class SubscriptionPlan {
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) description: string | null;

  // ── Billing (system of record is always USD) ─────────────────────────────
  @Prop({ type: Number, required: true }) monthlyPriceUSD: number;
  @Prop({ type: Number, default: null }) yearlyPriceUSD: number | null;

  // ── Cosmetic display only — NEVER used in billing, invoicing, or metrics ─
  // If displayCurrency is PKR, exchangeRateSnapshot holds the rate captured at
  // plan creation so customer-facing pages can show a converted price without
  // a live FX call. Billing always uses monthlyPriceUSD / yearlyPriceUSD.
  @Prop({ type: String, enum: ['USD', 'PKR'], default: 'USD' }) displayCurrency: string;
  @Prop({ type: Number, default: null }) exchangeRateSnapshot: number | null;

  @Prop({ type: [String], default: [] }) features: string[];

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: string;
  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionPlanSchema = SchemaFactory.createForClass(SubscriptionPlan);
SubscriptionPlanSchema.index({ sellerId: 1, status: 1 });
SubscriptionPlanSchema.index({ sellerId: 1, createdAt: -1 });
