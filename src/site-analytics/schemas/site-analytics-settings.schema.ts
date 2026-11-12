/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** Solvexo's own website analytics settings: one document (`key: 'platform'`). */
@Schema({ collection: 'site_analytics_settings', timestamps: true })
export class SiteAnalyticsSettings {
  @Prop({ required: true, unique: true, default: 'platform' })
  key: string;

  /** GA4 web stream measurement id (G-XXXXXXXXXX) loaded on the public site and sign-up. */
  @Prop({ type: String, default: null })
  measurementId: string | null;

  /** Tracking switch: off stops the public site loading Google Analytics without forgetting the id. */
  @Prop({ default: true })
  enabled: boolean;

  @Prop({ type: String, default: null })
  updatedByAdminId: string | null;
}

export type SiteAnalyticsSettingsDocument = HydratedDocument<SiteAnalyticsSettings>;
export const SiteAnalyticsSettingsSchema = SchemaFactory.createForClass(SiteAnalyticsSettings);
