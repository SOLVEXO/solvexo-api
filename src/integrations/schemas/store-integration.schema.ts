/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreIntegrationDocument = StoreIntegration & Document;

export const STORE_INTEGRATION_TYPES = ['payment', 'whatsapp'] as const;
export type StoreIntegrationType = (typeof STORE_INTEGRATION_TYPES)[number];

export const STORE_INTEGRATION_PROVIDERS = [
  'jazzcash',
  'easypaisa',
  'payfast',
  'safepay',
  'stripe',
  'whatsapp_cloud',
] as const;
export type StoreIntegrationProvider = (typeof STORE_INTEGRATION_PROVIDERS)[number];

export const STORE_INTEGRATION_MODES = ['sandbox', 'live'] as const;
export type StoreIntegrationMode = (typeof STORE_INTEGRATION_MODES)[number];

export const STORE_INTEGRATION_STATUSES = ['not_connected', 'connected', 'disabled', 'error', 'needs_reauth'] as const;
export type StoreIntegrationStatus = (typeof STORE_INTEGRATION_STATUSES)[number];

/**
 * One document per (storeId, type, provider): a seller's own connection to a
 * payment gateway or WhatsApp Business. Modeled directly on `SeoIntegration`
 * (seo/schemas/seo-integration.schema.ts) — same encrypted-credential shape,
 * generalized `config` bag, connection status machine.
 *
 * `credentialsEncrypted` holds a single AES-256-GCM blob
 * (`encryptCredential(JSON.stringify(fields), 'INTEGRATIONS')` from
 * common/credential-encryption.util.ts) containing whatever fields that one
 * provider needs (Stripe: secret key; JazzCash: merchant id + password +
 * integrity salt; WhatsApp Cloud: access token) — never plaintext, never
 * returned by any API response.
 */
@Schema({ timestamps: true })
export class StoreIntegration {
  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, enum: STORE_INTEGRATION_TYPES, required: true })
  type: StoreIntegrationType;

  @Prop({ type: String, enum: STORE_INTEGRATION_PROVIDERS, required: true })
  provider: StoreIntegrationProvider;

  @Prop({ type: String, enum: STORE_INTEGRATION_MODES, default: 'sandbox' })
  mode: StoreIntegrationMode;

  @Prop({ type: String, enum: STORE_INTEGRATION_STATUSES, default: 'not_connected' })
  status: StoreIntegrationStatus;

  @Prop({ type: String, default: null })
  credentialsEncrypted: string | null;

  // Non-secret display/behavior config: displayName, currency ('PKR'|'USD'),
  // merchantId (public), maskedHints (last-4 per secret field for display).
  @Prop({ type: Object, default: () => ({}) })
  config: Record<string, any>;

  // Payment type only — ignored for whatsapp.
  @Prop({ type: Boolean, default: false })
  isEnabledForCheckout: boolean;

  // Opaque per-integration webhook routing token (payment type only): the
  // gateway's webhook URL embeds this instead of storeId, so an inbound
  // webhook attributes itself to exactly one store without trusting anything
  // in the payload — see IntegrationWebhookEvent for the accompanying replay
  // dedup and the Phase 2 design doc §D for the full routing rationale.
  @Prop({ type: String, default: null })
  webhookToken: string | null;

  @Prop({ type: Date, default: null })
  lastVerifiedAt: Date | null;

  @Prop({ type: String, default: null })
  lastError: string | null;
}

export const StoreIntegrationSchema = SchemaFactory.createForClass(StoreIntegration);
StoreIntegrationSchema.index({ storeId: 1, type: 1, provider: 1 }, { unique: true });
StoreIntegrationSchema.index({ storeId: 1, type: 1 });
StoreIntegrationSchema.index({ webhookToken: 1 }, { unique: true, sparse: true });
// Defense-in-depth alongside the ownership check in StoreIntegrationsService.connectWhatsApp:
// two stores must never be able to claim the same WhatsApp phone number, since inbound
// webhook routing (WhatsAppWebhookController) resolves the target store purely from this field.
StoreIntegrationSchema.index({ 'config.phoneNumberId': 1 }, { unique: true, sparse: true });
