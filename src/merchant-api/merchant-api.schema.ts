/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true, collection: 'webhook_subscriptions' })
export class WebhookSubscription {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true, maxlength: 500 }) url: string;
  @Prop({ type: [String], default: [] }) events: string[];
  /** AES-GCM copy of the signing secret (needed to sign). Shown in full only on create / rotate. */
  @Prop({ required: true, select: false }) secretEnc: string;
  @Prop({ default: '' }) secretHint: string;
  @Prop({ default: true }) enabled: boolean;
  @Prop({ default: 0 }) consecutiveFailures: number;
  @Prop({ type: String, default: null }) disabledReason: string | null;
  @Prop({ type: String, default: '' }) description: string;
}
export type WebhookSubscriptionDocument = HydratedDocument<WebhookSubscription>;
export const WebhookSubscriptionSchema = SchemaFactory.createForClass(WebhookSubscription);

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'webhook_deliveries' })
export class WebhookDelivery {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) subscriptionId: string;
  @Prop({ required: true }) event: string;
  /** Same id for retries and redeliveries of one event (the receiver can dedupe on it). */
  @Prop({ required: true }) eventId: string;
  @Prop({ type: String, required: true }) payload: string;
  @Prop({ enum: ['pending', 'success', 'failed'], default: 'pending' }) status: string;
  @Prop({ default: 0 }) attempts: number;
  @Prop({ type: Date, default: null }) nextAttemptAt: Date | null;
  @Prop({ type: Number, default: null }) responseStatus: number | null;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ default: false }) inFlight: boolean;
  @Prop({ type: Date, default: null }) lastAttemptAt: Date | null;
}
export type WebhookDeliveryDocument = HydratedDocument<WebhookDelivery>;
export const WebhookDeliverySchema = SchemaFactory.createForClass(WebhookDelivery);
WebhookDeliverySchema.index({ subscriptionId: 1, eventId: 1 }, { unique: true });
WebhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
WebhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 86_400 });

@Schema({ timestamps: true, collection: 'api_tokens' })
export class ApiToken {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true, maxlength: 80 }) name: string;
  @Prop({ required: true, unique: true }) tokenHash: string;
  @Prop({ required: true }) prefix: string;
  @Prop({ type: [String], default: [] }) scopes: string[];
  @Prop({ type: Date, default: null }) revokedAt: Date | null;
  @Prop({ type: Date, default: null }) lastUsedAt: Date | null;
  @Prop({ default: '' }) createdBy: string;
}
export type ApiTokenDocument = HydratedDocument<ApiToken>;
export const ApiTokenSchema = SchemaFactory.createForClass(ApiToken);
