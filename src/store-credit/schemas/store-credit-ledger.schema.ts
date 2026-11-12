/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';
import { makeAppendOnly } from '../../pos/schemas/pos-immutable.util';

/**
 * The NEW store-credit ledger (G3.3, decision D3): minor units only, append-only events + the lots they create.
 *
 *  - `StoreCreditEntry` — APPEND-ONLY: one row per event (issue, adjust, redeem at the storefront, spend at the till, restore / spend_reversal, refund as credit, expire,
 *    opening_balance from the migration). Signed `amountMinor`, `balanceAfterMinor`, who / where / which document. Never edited.
 *  - `StoreCreditLot` — the spendable pieces of credit: `remainingMinor` is changed ONLY by a conditional `$inc` (so two tills, or a till and the storefront, can never take
 *    the same unit — spending the last of a balance twice is impossible by construction). A balance = Σ remaining of non-expired lots, so there is no balance to drift.
 *    Reconcile identity: for every lot, `amountMinor − remainingMinor − expiredMinor = Σ consumed by entries + reversals` (checked by the migration / tests).
 */
export const STORE_CREDIT_ENTRY_TYPES = ['issue', 'adjust_credit', 'adjust_debit', 'redeem', 'restore', 'refund_credit', 'expire', 'opening_balance', 'spend', 'spend_reversal'] as const;
export type StoreCreditEntryType = (typeof STORE_CREDIT_ENTRY_TYPES)[number];

export type StoreCreditEntryDocument = StoreCreditEntry & Document;
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class StoreCreditEntry {
  @Prop({ type: String, required: true }) storeId: string;
  /** the user id (storefront buyer) or the POS customer id — whoever the credit belongs to */
  @Prop({ type: String, required: true }) customerId: string;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;
  @Prop({ type: String, enum: STORE_CREDIT_ENTRY_TYPES, required: true }) type: StoreCreditEntryType;
  /** signed: + adds credit, − removes it */
  @Prop({ type: 'MinorMoney', required: true }) amountMinor: number;
  @Prop({ type: 'MinorMoney', required: true }) balanceAfterMinor: number;
  @Prop({ type: String, default: null }) lotId: string | null;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  @Prop({ type: [Object], default: [] }) consumed: Array<{ lotId: string; amountMinor: number }>;
  @Prop({ type: String, default: null }) orderId: string | null;
  @Prop({ type: String, default: null }) checkoutId: string | null;
  @Prop({ type: String, default: null }) saleId: string | null;
  @Prop({ type: String, default: null }) refundId: string | null;
  @Prop({ type: String, default: null }) creditNoteNumber: string | null;
  /** unique per logical event: a retried request / webhook can never apply twice */
  @Prop({ type: String, default: null }) idemKey: string | null;
  @Prop({ type: String, default: '' }) note: string;
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ type: String, default: null }) actorRole: string | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  /** set on entries written by the migration: the id of the legacy row they came from */
  @Prop({ type: String, default: null }) legacyId: string | null;
  createdAt?: Date;
}
export const StoreCreditEntrySchema = SchemaFactory.createForClass(StoreCreditEntry);
StoreCreditEntrySchema.set('toJSON', { getters: true, virtuals: false });
StoreCreditEntrySchema.set('toObject', { getters: true, virtuals: false });
StoreCreditEntrySchema.index({ storeId: 1, customerId: 1, createdAt: -1 });
StoreCreditEntrySchema.index({ storeId: 1, type: 1, idemKey: 1 }, { unique: true, partialFilterExpression: { idemKey: { $type: 'string' } }, name: 'uniq_credit_event' });
StoreCreditEntrySchema.index({ legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: 'string' } }, name: 'uniq_credit_legacy' });
makeAppendOnly(StoreCreditEntrySchema);

export type StoreCreditLotDocument = StoreCreditLot & Document;
@Schema({ timestamps: true })
export class StoreCreditLot {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) customerId: string;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;
  @Prop({ type: 'MinorMoney', required: true }) amountMinor: number;
  @Prop({ type: 'MinorMoney', required: true }) remainingMinor: number;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  @Prop({ type: Boolean, default: false }) expiredHandled: boolean;
  /** the entry that created this lot */
  @Prop({ type: String, default: null }) entryId: string | null;
  @Prop({ type: String, default: null }) source: string | null;
  @Prop({ type: String, default: null }) legacyId: string | null;
  createdAt?: Date;
}
export const StoreCreditLotSchema = SchemaFactory.createForClass(StoreCreditLot);
StoreCreditLotSchema.set('toJSON', { getters: true, virtuals: false });
StoreCreditLotSchema.set('toObject', { getters: true, virtuals: false });
StoreCreditLotSchema.index({ storeId: 1, customerId: 1, currency: 1, remainingMinor: 1, expiresAt: 1 });
StoreCreditLotSchema.index({ expiresAt: 1, remainingMinor: 1, expiredHandled: 1 });
StoreCreditLotSchema.index({ legacyId: 1 }, { unique: true, partialFilterExpression: { legacyId: { $type: 'string' } }, name: 'uniq_lot_legacy' });
