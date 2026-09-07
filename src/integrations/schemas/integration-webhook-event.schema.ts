/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type IntegrationWebhookEventDocument = HydratedDocument<IntegrationWebhookEvent>;

/**
 * Dedup record for the new per-store payment-gateway webhooks (JazzCash,
 * Easypaisa, PayFast, Safepay). Deliberately a separate collection from
 * `StripeWebhookEvent` (payment/schemas/stripe-webhook-event.schema.ts) and
 * the subscriptions billing webhook-event schema, following this codebase's
 * existing convention of one dedicated dedup table per webhook path rather
 * than a shared generic one. A unique index on {provider, externalEventId}
 * means a redelivered webhook fails to insert here and is treated as an
 * already-processed no-op, without ever needing to re-run order-mutating
 * logic for a retried delivery.
 */
@Schema({ timestamps: true })
export class IntegrationWebhookEvent {
  @Prop({ type: String, required: true })
  provider: string;

  @Prop({ type: String, required: true })
  externalEventId: string;

  @Prop({ type: String, required: true })
  storeId: string;

  createdAt?: Date;
}

export const IntegrationWebhookEventSchema = SchemaFactory.createForClass(IntegrationWebhookEvent);
IntegrationWebhookEventSchema.index({ provider: 1, externalEventId: 1 }, { unique: true });
