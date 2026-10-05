/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TransactionDocument = Transaction & Document;

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // Type of financial event
  @Prop({
    type: String,
    enum: ['sale', 'payout', 'fee', 'refund', 'adjustment', 'platform_subsidy'],
    required: true,
  })
  type: string;

  // Positive = credit, negative = debit
  @Prop({ type: Number, required: true }) amount: number;
  @Prop({ type: Number, required: true }) balanceBefore: number;
  @Prop({ type: Number, required: true }) balanceAfter: number;

  // Which of the seller's per-currency balances this entry moved — a seller
  // can hold both a USD balance (Stripe sales) and a PKR balance (Pakistan
  // manual-transfer sales) on the same store, so amounts across currencies
  // must never be summed together.
  @Prop({ type: String, default: 'USD' }) currency: string;

  // Human-readable description shown in transaction history
  @Prop({ type: String, required: true }) description: string;

  // Reference to the source document (orderId, payoutId, etc.)
  @Prop({ type: String, default: null }) referenceId: string | null;
  @Prop({
    type: String,
    enum: ['order', 'payout', 'manual', 'subscription_invoice', 'platform_plan_invoice', 'booking', 'package_purchase', null],
    default: null,
  })
  referenceType: string | null;

  @Prop({
    type: String,
    enum: ['completed', 'pending', 'failed'],
    default: 'completed',
  })
  status: string;

  // The platform-admin view is USD-only. Like Shopify (each transaction keeps the rate of the day it happened), the USD
  // value of a ledger entry is FROZEN when it is written, so a later FX move never rewrites history. Both are null for
  // rows written before this existed (and for a currency with no rate at that moment) — readers then fall back to the
  // latest rate. `amountUSD` is signed like `amount`; `ratePerUSD` = units of `currency` per 1 USD.
  @Prop({ type: Number, default: null }) amountUSD: number | null;
  @Prop({ type: Number, default: null }) ratePerUSD: number | null;

  // Extra metadata (fee breakdown, order items count, etc.)
  @Prop({ type: Object, default: null }) metadata: Record<string, any> | null;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

// Stamp the frozen USD value on every NEW ledger entry. Never blocks or fails the money movement itself.
TransactionSchema.pre('save', async function () {
  const doc: any = this;
  if (!doc.isNew || doc.ratePerUSD != null) return;
  try {
    const currency = String(doc.currency || 'USD');
    let rate: number | null = currency === 'USD' ? 1 : null;
    if (rate == null) {
      const row: any = await doc.db.model('ExchangeRate')
        .findOne({ currency, isRejected: false, effectiveFrom: { $lte: new Date() } })
        .sort({ effectiveFrom: -1 }).select('ratePerUSD').lean();
      rate = row?.ratePerUSD > 0 ? row.ratePerUSD : null;
    }
    if (rate) { doc.ratePerUSD = rate; doc.amountUSD = Math.round((doc.amount / rate) * 100) / 100; }
  } catch { /* the stamp is best-effort */ }
});
TransactionSchema.index({ storeId: 1, createdAt: -1 });
TransactionSchema.index({ storeId: 1, type: 1, createdAt: -1 });
TransactionSchema.index({ referenceId: 1 });
// One sale credit per (store, order): the DB-level guard behind recordSale's idempotency check
// (a concurrent double call loses the race on this index instead of double-crediting the seller).
// NOTE: if historical duplicate sale rows exist this index cannot build until they are de-duplicated.
TransactionSchema.index(
  { storeId: 1, referenceId: 1, referenceType: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: 'sale', referenceType: 'order' } },
);
