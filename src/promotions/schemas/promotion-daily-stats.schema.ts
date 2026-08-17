/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PromotionDailyStatsDocument = HydratedDocument<PromotionDailyStats>;
export type PromotionEntityType = 'store_banner' | 'promotion_request' | 'banner';

// One document per (entityType, entityId, date) — daily rollup, not a raw
// per-impression log (impressions are atomic $inc's straight into this doc
// to avoid write amplification at scale).
@Schema({ timestamps: true })
export class PromotionDailyStats {
  @Prop({ type: String, required: true })
  entityType: PromotionEntityType;

  @Prop({ required: true, index: true })
  entityId: string;

  // Stored as 'YYYY-MM-DD' (UTC) — simple to index/group by, no timezone ambiguity.
  @Prop({ required: true })
  date: string;

  @Prop({ default: 0 })
  impressions: number;

  @Prop({ default: 0 })
  clicks: number;

  @Prop({ default: 0 })
  conversions: number;

  @Prop({ default: 0 })
  revenueUSD: number;

  @Prop({ default: 0 })
  orders: number;

  @Prop({ type: Object, default: () => ({ desktop: 0, mobile: 0, tablet: 0 }) })
  byDevice: { desktop: number; mobile: number; tablet: number };

  // Country code -> count. Low cardinality (~250 countries), safe to roll up
  // (unlike city, which stays on the raw PromotionClickEvent only).
  @Prop({ type: Object, default: () => ({}) })
  byCountry: Record<string, number>;
}

export const PromotionDailyStatsSchema = SchemaFactory.createForClass(PromotionDailyStats);

PromotionDailyStatsSchema.index({ entityType: 1, entityId: 1, date: 1 }, { unique: true });
