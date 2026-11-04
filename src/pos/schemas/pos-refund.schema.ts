/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';

export type PosRefundDocument = PosRefund & Document;

/** One refund event against a sale, as its own immutable record with its own id and a human reference. */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosRefund {
  @Prop({ required: true }) saleId: string;
  @Prop({ type: String, default: null }) saleNumber: string | null;
  /** Position of this refund in the sale's `refunds[]` (0-based). (saleId, seq) is unique — two attempts can't both be refund #n. */
  @Prop({ type: Number, required: true }) seq: number;
  /** Human reference, e.g. "POS-00012-R1". */
  @Prop({ required: true }) reference: string;

  @Prop({ enum: ['full', 'partial'], required: true }) kind: string;
  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: String, default: null }) currency: string | null;
  @Prop({ type: Number, default: null }) currencyExponent: number | null;
  /** Per-tender split of the refund. Card / other tenders are only recorded, never confirmed by a terminal today. */
  @Prop({ type: [{ _id: false, method: String, amount: Number }], default: [] })
  tenders: Array<{ method: string; amount: number }>;
  @Prop({ type: [{ _id: false, saleItemId: String, qty: Number }], default: [] })
  items: Array<{ saleItemId: string; qty: number }>;
  @Prop({ type: String, default: null }) reason: string | null;

  @Prop({ enum: ['confirmed', 'recorded_unverified'], required: true }) status: string;
  @Prop({ type: String, default: null }) confirmationSource: string | null;

  // transaction context (server-derived). `sessionId/registerId/shiftId` are the shift the refund HAPPENED in
  // (the register's open session now), which can differ from the sale's own session.
  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  @Prop({ type: String, default: null }) shiftId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  /** Manager whose PIN session authorised it. */
  @Prop({ type: String, default: null }) employeeId: string | null;
  /** The sale's own context, for traceability. */
  @Prop({ type: String, default: null }) saleSessionId: string | null;
  @Prop({ type: String, default: null }) saleEmployeeId: string | null;

  /** The request's Idempotency-Key, when sent. Unique per sale. */
  @Prop({ type: String }) idempotencyKey?: string | null;
  @Prop({ type: Boolean }) backfilled?: boolean;
}

export const PosRefundSchema = SchemaFactory.createForClass(PosRefund);

PosRefundSchema.index({ saleId: 1, seq: 1 }, { unique: true, name: 'uniq_refund_seq_per_sale' });
PosRefundSchema.index(
  { saleId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'uniq_refund_idem_per_sale' },
);
PosRefundSchema.index({ storeId: 1, createdAt: -1 });
PosRefundSchema.index({ storeId: 1, sessionId: 1 });

makeAppendOnly(PosRefundSchema);
