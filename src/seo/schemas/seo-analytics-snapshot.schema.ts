/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoAnalyticsSnapshotDocument = SeoAnalyticsSnapshot & Document;

/**
 * Periodic GSC search-performance + GA4 organic-traffic pull — one row per
 * (scope, provider, date). Powers both admin and (scoped) seller SEO
 * analytics dashboards, same "one table, filtered by scope" shape as
 * `Transaction`/`ActivityLog` elsewhere in this codebase.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SeoAnalyticsSnapshot {
  @Prop({ type: String, enum: ['platform', 'store'], required: true })
  scope: 'platform' | 'store';

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, enum: ['gsc', 'ga4', 'bing'], required: true })
  provider: 'gsc' | 'ga4' | 'bing';

  @Prop({ type: String, required: true }) // YYYY-MM-DD
  date: string;

  @Prop({ type: Number, default: null }) clicks: number | null;
  @Prop({ type: Number, default: null }) impressions: number | null;
  @Prop({ type: Number, default: null }) ctr: number | null;
  @Prop({ type: Number, default: null }) avgPosition: number | null;
  @Prop({ type: Number, default: null }) organicSessions: number | null;
}

export const SeoAnalyticsSnapshotSchema = SchemaFactory.createForClass(SeoAnalyticsSnapshot);
SeoAnalyticsSnapshotSchema.index({ scope: 1, storeId: 1, provider: 1, date: 1 }, { unique: true });
