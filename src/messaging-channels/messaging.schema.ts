/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** All records are store-scoped: a contact's consent with one store says nothing about another store. */

/** Explicit, per-channel opt-in record (separate from email consent). `opted_out` is permanent until the person opts in again. */
@Schema({ timestamps: true, collection: 'messagingconsents' })
export class MessagingConsent {
  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, enum: ['whatsapp', 'sms'], required: true }) channel: string;
  @Prop({ required: true }) contactKey: string;
  @Prop({ type: String, default: null }) customerId: string | null;
  @Prop({ type: String, default: null, maxlength: 120 }) name: string | null;
  @Prop({ type: String, enum: ['opted_in', 'opted_out'], required: true }) status: string;
  /** How the opt-in was obtained (checkout checkbox, storefront form, manual entry by the seller, import with attestation). */
  @Prop({ type: String, default: null }) optInSource: string | null;
  @Prop({ type: Date, default: null }) optedInAt: Date | null;
  @Prop({ type: Date, default: null }) optedOutAt: Date | null;
  @Prop({ type: String, default: null }) optOutSource: string | null;
  @Prop({ type: [{ status: String, at: Date, source: String, _id: false }], default: [] }) history: { status: string; at: Date; source: string }[];
}
export type MessagingConsentDocument = MessagingConsent & Document;
export const MessagingConsentSchema = SchemaFactory.createForClass(MessagingConsent);
MessagingConsentSchema.index({ storeId: 1, channel: 1, contactKey: 1 }, { unique: true });
MessagingConsentSchema.index({ storeId: 1, channel: 1, status: 1, updatedAt: -1 });

/** The store's own copy of a WhatsApp message template (status comes from Meta). */
@Schema({ timestamps: true, collection: 'whatsapptemplates' })
export class WhatsAppTemplate {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) language: string;
  @Prop({ type: String, default: 'MARKETING' }) category: string;
  @Prop({ type: String, default: 'PENDING' }) status: string;
  @Prop({ type: String, default: '' }) bodyText: string;
  @Prop({ type: Number, default: 0 }) paramCount: number;
  @Prop({ type: String, default: null }) metaId: string | null;
  @Prop({ type: String, default: null }) rejectedReason: string | null;
  @Prop({ type: Date, default: null }) lastSyncedAt: Date | null;
}
export type WhatsAppTemplateDocument = WhatsAppTemplate & Document;
export const WhatsAppTemplateSchema = SchemaFactory.createForClass(WhatsAppTemplate);
WhatsAppTemplateSchema.index({ storeId: 1, name: 1, language: 1 }, { unique: true });

@Schema({ timestamps: true, collection: 'messagingcampaigns' })
export class MessagingCampaign {
  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, enum: ['whatsapp', 'sms'], default: 'whatsapp' }) channel: string;
  @Prop({ required: true, trim: true, maxlength: 120 }) name: string;
  /** null = every opted-in contact of the store. */
  @Prop({ type: String, default: null }) segmentId: string | null;
  @Prop({ type: String, default: null }) templateId: string | null;
  /** One entry per template placeholder: {customer_name}, {store_name} or fixed text. */
  @Prop({ type: [String], default: [] }) params: string[];
  @Prop({ type: String, default: null, maxlength: 500 }) smsText: string | null;
  @Prop({ type: String, enum: ['draft', 'sending', 'completed', 'canceled', 'failed'], default: 'draft' }) status: string;
  @Prop({ type: Number, default: null, min: 1 }) dailyLimit: number | null;
  @Prop({ type: Date, default: null }) startedAt: Date | null;
  @Prop({ type: Date, default: null }) completedAt: Date | null;
  @Prop({ type: String, default: null }) createdBy: string | null;
}
export type MessagingCampaignDocument = MessagingCampaign & Document;
export const MessagingCampaignSchema = SchemaFactory.createForClass(MessagingCampaign);
MessagingCampaignSchema.index({ storeId: 1, createdAt: -1 });
MessagingCampaignSchema.index({ status: 1 });

/** One row per (campaign, contact): the send log, the delivery state and the reason a contact was skipped. */
@Schema({ timestamps: true, collection: 'messagingmessages' })
export class MessagingMessage {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) campaignId: string;
  @Prop({ type: String, enum: ['whatsapp', 'sms'], required: true }) channel: string;
  @Prop({ required: true }) contactKey: string;
  @Prop({ type: String, default: null }) customerId: string | null;
  @Prop({ type: String, default: null }) customerName: string | null;
  @Prop({ type: String, default: 'queued' }) status: string;
  @Prop({ type: String, default: null }) providerMessageId: string | null;
  @Prop({ type: String, default: null, maxlength: 400 }) error: string | null;
  @Prop({ type: Number, default: 0 }) attempts: number;
  @Prop({ type: Date, default: null }) sendingAt: Date | null;
  /** true while one worker is sending this message: a second worker (job redelivery) skips it. */
  @Prop({ type: Boolean, default: false }) inFlight: boolean;
  @Prop({ type: Date, default: null }) sentAt: Date | null;
  @Prop({ type: Date, default: null }) deliveredAt: Date | null;
  @Prop({ type: Date, default: null }) readAt: Date | null;
}
export type MessagingMessageDocument = MessagingMessage & Document;
export const MessagingMessageSchema = SchemaFactory.createForClass(MessagingMessage);
MessagingMessageSchema.index({ campaignId: 1, contactKey: 1 }, { unique: true });
MessagingMessageSchema.index({ storeId: 1, campaignId: 1, status: 1 });
MessagingMessageSchema.index({ storeId: 1, providerMessageId: 1 }, { sparse: true });
MessagingMessageSchema.index({ storeId: 1, channel: 1, sentAt: -1 });

/** A store's SMS gateway (generic HTTP). Off until a real test message succeeds; any change to the request switches it off again. */
@Schema({ timestamps: true, collection: 'smsgatewayconfigs' })
export class SmsGatewayConfig {
  @Prop({ required: true, unique: true }) storeId: string;
  @Prop({ type: String, default: null }) presetKey: string | null;
  @Prop({ type: Object, default: null }) http: Record<string, any> | null;
  @Prop({ type: String, default: '' }) senderId: string;
  @Prop({ type: String, default: null, select: false }) secretEnc: string | null;
  @Prop({ type: String, default: null, select: false }) webhookSecretHash: string | null;
  @Prop({ type: Number, default: 1000, min: 1 }) dailyLimit: number;
  @Prop({ type: Boolean, default: false }) enabled: boolean;
  @Prop({ type: Date, default: null }) verifiedAt: Date | null;
  @Prop({ type: String, default: null }) lastError: string | null;
}
export type SmsGatewayConfigDocument = SmsGatewayConfig & Document;
export const SmsGatewayConfigSchema = SchemaFactory.createForClass(SmsGatewayConfig);
