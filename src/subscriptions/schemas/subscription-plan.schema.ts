/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionPlanDocument = SubscriptionPlan & Document;

@Schema({ timestamps: true })
export class SubscriptionPlan {
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;

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

  // Freeform marketing bullets — cosmetic only, shown on the plan card.
  @Prop({ type: [String], default: [] }) features: string[];

  // Structured, server-enforced benefits — the real mechanism. `features`
  // above is descriptive copy only; this is what checkout/pricing/loyalty
  // actually enforce. See PlanBenefitDto for the shape of each entry.
  @Prop({ type: [Object], default: [] }) benefits: Record<string, any>[];

  // 'suspended' is an admin-forced state (moderation) — distinct from the
  // seller's own 'archived' action; hidden from buyer browse either way.
  @Prop({ type: String, enum: ['active', 'archived', 'suspended'], default: 'active' }) status: string;
  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionPlanSchema = SchemaFactory.createForClass(SubscriptionPlan);
SubscriptionPlanSchema.index({ storeId: 1, status: 1 });
SubscriptionPlanSchema.index({ storeId: 1, createdAt: -1 });
SubscriptionPlanSchema.index({ sellerId: 1, createdAt: -1 });
