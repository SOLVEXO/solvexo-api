/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';
import '../../common/schema-types/minor-money';

export type PosPaymentDocument = PosPayment & Document;

/**
 * Payment status AT INSERT. Cash that the cashier physically took is `confirmed`; card / other tenders are only RECORDED by the
 * cashier today (no terminal or gateway integration yet), so they are `recorded_unverified` until something with
 * authority — a reconciled shift close, a terminal, Raast — says otherwise (`confirmationSource`, null for now).
 */
export const PAYMENT_STATUSES = ['confirmed', 'recorded_unverified'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** One tender line of one sale, as its own immutable record with its own id. The sale's embedded `payments[]` stays (old app builds read it). */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosPayment {
  @Prop({ required: true }) saleId: string;
  @Prop({ type: String, default: null }) saleNumber: string | null;
  /** Index of this tender in the sale's `payments[]` — (saleId, lineNo) is unique, so a retry can never add a second row. */
  @Prop({ type: Number, required: true }) lineNo: number;

  @Prop({ enum: ['cash', 'card', 'other', 'raast_qr'], required: true }) tender: string;
  /** What was APPLIED to the sale total (cash net of change), in the sale's currency (major units until G1b). */
  @Prop({ type: Number, required: true }) amount: number;
  // G1b: integer minor-unit twin (minor-native from step a; the decimal stays in step with it)
  @Prop({ type: 'MinorMoney' }) amountMinor?: number;
  @Prop({ type: Number, default: null }) tendered: number | null;
  @Prop({ type: 'MinorMoney' }) tenderedMinor?: number;
  @Prop({ type: String, default: null }) currency: string | null;
  @Prop({ type: Number, default: null }) currencyExponent: number | null;
  /** Card auth code / bank transfer ref typed by the cashier. */
  @Prop({ type: String, default: null }) reference: string | null;

  @Prop({ enum: PAYMENT_STATUSES, required: true }) status: string;
  /** What confirmed it: null today; later 'terminal' | 'gateway' | 'raast' | 'shift_reconciliation'. */
  @Prop({ type: String, default: null }) confirmationSource: string | null;
  @Prop({ type: Date, default: null }) confirmedAt: Date | null;
  /** raast_qr: the payment_intents id this row settles (the row is written when the sale is, already confirmed). */
  @Prop({ type: String, default: null }) paymentIntentId: string | null;

  // transaction context — always derived server-side (token / session / device), never trusted from the request body
  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  @Prop({ type: String, default: null }) shiftId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;

  /** The checkout's idempotency key (the sale's), when the client sent one. Unique together with lineNo. */
  @Prop({ type: String }) idempotencyKey?: string | null;
  /** Set only by the backfill migration, so it can be reversed without touching live records. */
  @Prop({ type: Boolean }) backfilled?: boolean;
  @Prop({ type: Date }) minorBackfilledAt?: Date;
}

export const PosPaymentSchema = SchemaFactory.createForClass(PosPayment);
PosPaymentSchema.set('toJSON', { getters: true, virtuals: false });
PosPaymentSchema.set('toObject', { getters: true, virtuals: false });

PosPaymentSchema.index({ saleId: 1, lineNo: 1 }, { unique: true, name: 'uniq_payment_line_per_sale' });
// A retry of the same checkout (same key) can never create a second payment row for the same tender line.
PosPaymentSchema.index(
  { storeId: 1, idempotencyKey: 1, lineNo: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'uniq_payment_idem_line' },
);
PosPaymentSchema.index({ storeId: 1, sessionId: 1, tender: 1 });
PosPaymentSchema.index({ storeId: 1, createdAt: -1 });

// G2.1: fully append-only, no allowSetFields. A digital payment's lifecycle lives in the `payment_events` collection
// (current status = latest event), so no payment row is ever updated after insert and an insert-only DB role works.
makeAppendOnly(PosPaymentSchema);
