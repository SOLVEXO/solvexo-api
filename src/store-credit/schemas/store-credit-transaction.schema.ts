/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreCreditTransactionDocument = StoreCreditTransaction & Document;

export const STORE_CREDIT_TX_TYPES = [
  'issue',          // seller credited the customer (Shopify: "Issue store credit")
  'adjust_credit',  // seller added to an existing balance
  'adjust_debit',   // seller removed credit
  'redeem',         // customer spent credit on an order
  'restore',        // credit used on an order came back (cancel / return)
  'refund_credit',  // an order refund was issued AS store credit
  'expire',         // an expiry date passed with credit unspent
] as const;
export type StoreCreditTxType = (typeof STORE_CREDIT_TX_TYPES)[number];

/**
 * One row of a customer's store-credit ledger for one store (Shopify "Store credit": a balance per
 * customer, spent automatically at checkout, issued/adjusted by the merchant, optionally expiring,
 * and usable as the destination of a refund).
 *
 * Credits are LOTS: `remaining` is what is still spendable of that credit (so an expiry date can
 * apply to exactly the credit it was set on). A customer's balance is the sum of `remaining` over
 * their non-expired lots — there is no separate balance document to drift out of sync.
 */
@Schema({ timestamps: true })
export class StoreCreditTransaction {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) customerId: string;
  /** The store's base currency (credit is held in the store's own currency). */
  @Prop({ type: String, required: true }) currency: string;

  @Prop({ type: String, enum: STORE_CREDIT_TX_TYPES, required: true }) type: StoreCreditTxType;
  /** Signed: + adds credit, − removes it. */
  @Prop({ type: Number, required: true }) amount: number;
  /** The customer's spendable balance right after this row. */
  @Prop({ type: Number, required: true }) balanceAfter: number;

  // ── credit lots only (issue / adjust_credit / restore / refund_credit) ──
  @Prop({ type: Number, default: 0 }) remaining: number;
  @Prop({ type: Date, default: null }) expiresAt: Date | null;
  /** Set once an expiry sweep has processed this lot. */
  @Prop({ type: Boolean, default: false }) expiredHandled: boolean;

  // ── debits only (redeem / adjust_debit): which lots were drawn from, so a restore is exact ──
  @Prop({ type: [Object], default: [] }) consumed: Array<{ lotId: string; amount: number }>;

  @Prop({ type: String, default: null }) orderId: string | null;
  @Prop({ type: String, default: null }) checkoutId: string | null;
  /** Unique per logical event so a retried request/webhook can never apply twice. */
  @Prop({ type: String, default: null }) idemKey: string | null;

  @Prop({ type: String, default: '' }) note: string;
  @Prop({ type: String, default: null }) actorId: string | null;
  @Prop({ type: String, default: null }) actorRole: string | null;
}

export const StoreCreditTransactionSchema = SchemaFactory.createForClass(StoreCreditTransaction);
StoreCreditTransactionSchema.index({ storeId: 1, customerId: 1, createdAt: -1 });
StoreCreditTransactionSchema.index({ storeId: 1, customerId: 1, currency: 1, remaining: 1, expiresAt: 1 });
StoreCreditTransactionSchema.index({ expiresAt: 1, remaining: 1, expiredHandled: 1 });
StoreCreditTransactionSchema.index(
  { storeId: 1, type: 1, idemKey: 1 },
  { unique: true, partialFilterExpression: { idemKey: { $type: 'string' } } },
);
