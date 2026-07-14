/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoIntegrationDocument = SeoIntegration & Document;

export const SEO_INTEGRATION_PROVIDERS = ['gsc', 'ga4', 'merchant_center', 'bing'] as const;
export type SeoIntegrationProvider = (typeof SEO_INTEGRATION_PROVIDERS)[number];

export const SEO_INTEGRATION_STATUSES = ['connected', 'syncing', 'error', 'needs_reauth', 'disconnected'] as const;
export type SeoIntegrationStatus = (typeof SEO_INTEGRATION_STATUSES)[number];

/**
 * One document per (scope, provider): a platform-wide connection (admin,
 * `scope: 'platform'`, `storeId: null`) or a store-specific one (seller,
 * `scope: 'store'`, gated by `searchConsoleIntegrationAllowed`). Shared by
 * both via `SeoIntegrationsService` — see architecture plan Refinement #2.
 *
 * `accessToken`/`refreshToken` are stored via `encryptSeoCredential()`
 * (common/seo-token-encryption.util.ts) — never in plaintext.
 */
@Schema({ timestamps: true })
export class SeoIntegration {
  @Prop({ type: String, enum: ['platform', 'store'], required: true })
  scope: 'platform' | 'store';

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, default: null })
  sellerId: string | null;

  @Prop({ type: String, enum: SEO_INTEGRATION_PROVIDERS, required: true })
  provider: SeoIntegrationProvider;

  @Prop({ type: String, default: null })
  accessTokenEncrypted: string | null;

  @Prop({ type: String, default: null })
  refreshTokenEncrypted: string | null;

  @Prop({ type: Date, default: null })
  accessTokenExpiresAt: Date | null;

  // Provider-specific identifiers (GSC/Bing site URL, GA4 property id,
  // Merchant Center account id) — free-form since each provider's shape differs.
  @Prop({ type: Object, default: () => ({}) })
  config: Record<string, any>;

  @Prop({ type: String, enum: SEO_INTEGRATION_STATUSES, default: 'disconnected' })
  status: SeoIntegrationStatus;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  lastSyncedAt: Date | null;
}

export const SeoIntegrationSchema = SchemaFactory.createForClass(SeoIntegration);
SeoIntegrationSchema.index({ scope: 1, storeId: 1, provider: 1 }, { unique: true });
