/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from '../../pos/schemas/pos-immutable.util';
import '../../common/schema-types/minor-money';

/**
 * G2.1 digital-payment records. EVERY collection here is append-only (`makeAppendOnly`): nothing is ever updated after insert, so they
 * work with an insert-only database role. State that changes over time is a new EVENT row; the current status is derived from the
 * events (`payment-status.util.ts`), never stored.
 */

export const PAYMENT_METHODS = ['raast_qr'] as const;

export const PAYMENT_EVENT_TYPES = [
  'created', 'presented', 'pending', 'confirmed', 'failed', 'expired', 'cancelled',
  'anomaly',       // something that needs a human: amount mismatch, confirmation after a failure, …
  'reconciled',    // a manager resolved a late / unattached / anomalous payment
  'consumed',      // the payment was attached to a completed sale (G2.3)
  'refund_requested', 'refund_succeeded', 'refund_failed',
] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/** Types that may occur at most once per intent (enforced by a unique index on `onceKey`, so two servers can never both write one). */
export const ONCE_PER_INTENT_TYPES: PaymentEventType[] = ['created', 'presented', 'pending', 'confirmed', 'failed', 'expired', 'cancelled', 'reconciled', 'consumed'];

export type PaymentIntentDocument = PaymentIntent & Document;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PaymentIntent {
  // transaction context — server-derived (device / employee token / session), never trusted from the body
  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  @Prop({ type: String, default: null }) shiftId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;

  @Prop({ enum: PAYMENT_METHODS, required: true }) method: string;
  @Prop({ required: true }) providerKey: string;
  @Prop({ required: true }) providerRef: string;
  @Prop({ required: true }) qrPayload: string;
  /** The store's provider sub-merchant reference at the time — settlement goes to that merchant's own bank account. */
  @Prop({ required: true }) subMerchantRef: string;

  @Prop({ type: 'MinorMoney', required: true }) amountMinor: number;
  @Prop({ required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;

  @Prop({ type: Date, required: true }) expiresAt: Date;
  /** Client-supplied checkout idempotency key: the same key returns the same intent. */
  @Prop({ required: true }) idempotencyKey: string;
  /** The checkout attempt this payment belongs to (the sale's idempotency key) — a late payment is attached back to it. */
  @Prop({ type: String, default: null }) saleAttemptKey: string | null;
}
export const PaymentIntentSchema = SchemaFactory.createForClass(PaymentIntent);
PaymentIntentSchema.set('toJSON', { getters: true, virtuals: false });
PaymentIntentSchema.set('toObject', { getters: true, virtuals: false });
PaymentIntentSchema.index({ storeId: 1, idempotencyKey: 1 }, { unique: true, name: 'uniq_intent_idem' });
PaymentIntentSchema.index({ providerKey: 1, providerRef: 1 }, { unique: true, name: 'uniq_intent_provider_ref' });
PaymentIntentSchema.index({ storeId: 1, createdAt: -1 });
PaymentIntentSchema.index({ storeId: 1, saleAttemptKey: 1 });
makeAppendOnly(PaymentIntentSchema);

export type PaymentEventDocument = PaymentEvent & Document;

@Schema({ timestamps: false })
export class PaymentEvent {
  @Prop({ required: true }) intentId: string;
  @Prop({ required: true }) storeId: string;
  /** 1, 2, 3 … per intent (unique together). Defines the order; "latest event" = highest seq. */
  @Prop({ type: Number, required: true }) seq: number;
  @Prop({ enum: PAYMENT_EVENT_TYPES, required: true }) type: string;
  @Prop({ type: 'MinorMoney' }) amountMinor?: number;
  @Prop({ enum: ['webhook', 'poll', 'system', 'cashier', 'manager'], required: true }) source: string;
  /** Provider's notification id — unique per provider, so a duplicate webhook cannot write a second event. */
  @Prop({ type: String }) providerEventId?: string;
  @Prop({ type: String }) providerKey?: string;
  /** For refund_* events: OUR refund id (unique per intent + type). */
  @Prop({ type: String }) refundId?: string;
  @Prop({ type: String }) providerRefundRef?: string;
  /** `confirmed` that arrived after the till had already expired / cancelled / failed the payment. */
  @Prop({ type: Boolean }) late?: boolean;
  @Prop({ type: String }) saleId?: string;
  @Prop({ type: String }) employeeId?: string;
  @Prop({ type: String }) note?: string;
  @Prop({ type: Object }) meta?: Record<string, unknown>;
  @Prop({ type: Date, required: true, default: () => new Date() }) at: Date;
  /** `${intentId}:${type}` for once-per-intent types, `${intentId}:${type}:${refundId}` for refund events. Unique where set. */
  @Prop({ type: String }) onceKey?: string;
}
export const PaymentEventSchema = SchemaFactory.createForClass(PaymentEvent);
PaymentEventSchema.set('toJSON', { getters: true, virtuals: false });
PaymentEventSchema.set('toObject', { getters: true, virtuals: false });
PaymentEventSchema.index({ intentId: 1, seq: 1 }, { unique: true, name: 'uniq_event_seq' });
PaymentEventSchema.index({ providerKey: 1, providerEventId: 1 }, { unique: true, partialFilterExpression: { providerEventId: { $type: 'string' } }, name: 'uniq_event_provider_event' });
PaymentEventSchema.index({ onceKey: 1 }, { unique: true, partialFilterExpression: { onceKey: { $type: 'string' } }, name: 'uniq_event_once' });
PaymentEventSchema.index({ storeId: 1, type: 1, at: -1 });
makeAppendOnly(PaymentEventSchema);

export type PaymentWebhookInboxDocument = PaymentWebhookInbox & Document;

/** Every VERIFIED webhook is written here first (durable) and only then processed — so a processing error never loses a notification. */
@Schema({ timestamps: { createdAt: 'receivedAt', updatedAt: false } })
export class PaymentWebhookInbox {
  @Prop({ required: true }) providerKey: string;
  @Prop({ required: true }) providerEventId: string;
  @Prop({ required: true }) rawDigest: string;
  /** The normalised, signature-verified outcome (no secrets, no headers). */
  @Prop({ type: Object, required: true }) outcome: Record<string, unknown>;
}
export const PaymentWebhookInboxSchema = SchemaFactory.createForClass(PaymentWebhookInbox);
PaymentWebhookInboxSchema.index({ providerKey: 1, providerEventId: 1 }, { unique: true, name: 'uniq_inbox_event' });
PaymentWebhookInboxSchema.index({ receivedAt: -1 });
makeAppendOnly(PaymentWebhookInboxSchema);

export type PaymentWebhookOutcomeDocument = PaymentWebhookOutcome & Document;

/** Append-only processing log for an inbox row: the retry queue = inbox rows with no `processed`/`ignored`/`dead` outcome. */
@Schema({ timestamps: { createdAt: 'at', updatedAt: false } })
export class PaymentWebhookOutcome {
  @Prop({ required: true }) inboxId: string;
  @Prop({ enum: ['processed', 'ignored', 'error', 'dead'], required: true }) result: string;
  @Prop({ type: Number, default: 1 }) attempt: number;
  @Prop({ type: String, default: null }) error: string | null;
}
export const PaymentWebhookOutcomeSchema = SchemaFactory.createForClass(PaymentWebhookOutcome);
PaymentWebhookOutcomeSchema.index({ inboxId: 1, at: 1 });
makeAppendOnly(PaymentWebhookOutcomeSchema);
