/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformConfigDocument = PlatformConfig & Document;

@Schema({ _id: false })
export class FeatureFlags {
  @Prop({ type: Boolean, default: true }) aiStudio: boolean;
  @Prop({ type: Boolean, default: true }) marketplace: boolean;
  @Prop({ type: Boolean, default: true }) digitalUploads: boolean;
  @Prop({ type: Boolean, default: false }) affiliateProgram: boolean;
  @Prop({ type: Boolean, default: false }) giftCards: boolean;
  @Prop({ type: Boolean, default: true }) posMode: boolean;
  @Prop({ type: Boolean, default: true }) storeBuilder: boolean;
  @Prop({ type: Boolean, default: false }) bulkProductImport: boolean;
  @Prop({ type: Boolean, default: true }) promotions: boolean;
}
export const FeatureFlagsSchema = SchemaFactory.createForClass(FeatureFlags);

// How many banners are simultaneously visible/rotating per placement — deliberately
// NOT a create-time cap (rows are unlimited); this only bounds the read-side
// `.limit()` so an oversubscribed placement rotates instead of overflowing the UI.
@Schema({ _id: false })
export class PlacementLimits {
  @Prop({ type: Number, default: 4 }) homepageHero: number;
  @Prop({ type: Number, default: 4 }) marketplaceHero: number;
  @Prop({ type: Number, default: 4 }) educationHero: number;
  @Prop({ type: Number, default: 4 }) categoryHero: number;
  @Prop({ type: Number, default: 4 }) storeHero: number;
  @Prop({ type: Number, default: 8 }) storeFeaturedProducts: number;
}
export const PlacementLimitsSchema = SchemaFactory.createForClass(PlacementLimits);

@Schema({ _id: false })
export class AiConfig {
  @Prop({ type: Number, default: 1000 }) monthlyCreditLimit: number;
  @Prop({ type: String, default: 'claude-sonnet-5' }) aiModel: string;
}
export const AiConfigSchema = SchemaFactory.createForClass(AiConfig);

@Schema({ _id: false })
export class EmailConfig {
  @Prop({ type: String, default: 'Solvexo' }) fromName: string;
  @Prop({ type: String, default: null }) fromEmail: string | null;
  @Prop({ type: String, default: null }) replyToEmail: string | null;
  @Prop({ type: String, default: 'SendGrid' }) provider: string;
}
export const EmailConfigSchema = SchemaFactory.createForClass(EmailConfig);

// Singleton collection — exactly one document ever exists, fetched/updated via
// upsert with an empty filter (see AdminConfigService), same convention used
// for other platform-wide single-doc settings in this codebase.
@Schema({ timestamps: true })
export class PlatformConfig {
  @Prop({ type: Boolean, default: false })
  maintenanceMode: boolean;

  @Prop({ type: FeatureFlagsSchema, default: () => ({}) })
  featureFlags: FeatureFlags;

  @Prop({ type: AiConfigSchema, default: () => ({}) })
  aiConfig: AiConfig;

  @Prop({ type: EmailConfigSchema, default: () => ({}) })
  emailConfig: EmailConfig;

  @Prop({ type: PlacementLimitsSchema, default: () => ({}) })
  placementLimits: PlacementLimits;

  // Untyped, like `PlatformPlan.limits` — a per-placement rate card needs to stay
  // freely extensible (new tiers, festival overrides) without a schema migration.
  // Shape: { [placement]: { hourly, daily, weekly, monthly, weekendMultiplier,
  // peakMultiplier, festivalOverrides: [{ name, startAt, endAt, rate }] } }
  @Prop({ type: Object, default: () => ({}) })
  promotionPricing: Record<string, unknown>;
}

export const PlatformConfigSchema = SchemaFactory.createForClass(PlatformConfig);
