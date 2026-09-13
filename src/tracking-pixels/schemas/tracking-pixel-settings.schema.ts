import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TrackingPixelSettingsDocument = TrackingPixelSettings & Document;

/** One doc per store — same singleton-per-store convention as
 *  AbandonedCartSettings/AffiliateProgram. Every id here is stored exactly
 *  as the seller pastes it from their own Facebook/Google/TikTok ad
 *  account — Solvexo never generates or holds any ad-platform credential of
 *  its own; these ids aren't secrets (they're literally visible in any
 *  page's rendered HTML/network requests once live), so — unlike
 *  StoreIntegration's OAuth tokens — nothing here goes through
 *  credential-encryption.util. A null field just means that one platform's
 *  script never loads for this store (see TrackingPixelsService.getPublicSettings
 *  and the storefront's loadPixelScripts, which skips whichever ids are null). */
@Schema({ timestamps: true })
export class TrackingPixelSettings {
  @Prop({ required: true, unique: true })
  storeId: string;

  // Meta (Facebook/Instagram) Pixel — e.g. "1234567890123456".
  @Prop({ type: String, default: null })
  facebookPixelId: string | null;

  // GA4 Measurement ID — e.g. "G-XXXXXXXXXX".
  @Prop({ type: String, default: null })
  googleAnalyticsId: string | null;

  // Google Ads Conversion ID — e.g. "AW-XXXXXXXXX".
  @Prop({ type: String, default: null })
  googleAdsId: string | null;

  // Paired with googleAdsId for the Purchase conversion action specifically
  // (Google Ads requires an id+label pair per conversion action, distinct
  // from the account-level googleAdsId alone).
  @Prop({ type: String, default: null })
  googleAdsConversionLabel: string | null;

  // TikTok Pixel — e.g. "C4A1B2C3D4E5F6G7H8I9".
  @Prop({ type: String, default: null })
  tiktokPixelId: string | null;

  @Prop({ default: false })
  isDelete: boolean;
}

export const TrackingPixelSettingsSchema = SchemaFactory.createForClass(TrackingPixelSettings);
