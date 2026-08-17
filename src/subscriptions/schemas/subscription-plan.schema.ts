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

  // ── Stripe catalog mirror ──────────────────────────────────────────────
  // A Stripe Product/Price pair is created lazily (on first subscribe, not on
  // plan creation) so plans that are never actually subscribed to don't
  // accumulate unused Stripe catalog objects. Price objects are immutable in
  // Stripe, so editing monthlyPriceUSD/yearlyPriceUSD does NOT update these —
  // it invalidates them (see StripePaymentProvider.getOrCreatePrice), and a
  // fresh Price is created on the next subscribe/renewal under the same Product.
  @Prop({ type: String, default: null }) stripeProductId: string | null;
  @Prop({ type: String, default: null }) stripeMonthlyPriceId: string | null;
  @Prop({ type: String, default: null }) stripeYearlyPriceId: string | null;
  // Bumped whenever monthlyPriceUSD/yearlyPriceUSD changes, so the Stripe
  // provider knows its cached Price ids are stale without a live Stripe call.
  @Prop({ type: Number, default: 0 }) priceRevision: number;

  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionPlanSchema = SchemaFactory.createForClass(SubscriptionPlan);
SubscriptionPlanSchema.index({ storeId: 1, status: 1 });
SubscriptionPlanSchema.index({ storeId: 1, createdAt: -1 });
SubscriptionPlanSchema.index({ sellerId: 1, createdAt: -1 });
