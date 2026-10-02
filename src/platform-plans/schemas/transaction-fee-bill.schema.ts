/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TransactionFeeBillDocument = TransactionFeeBill & Document;

/**
 * One monthly bill of a store's accrued transaction fees — Shopify's
 * "third-party transaction fee": a plan-based % charged on sales that did NOT
 * go through the platform's own card rail (the seller's own gateway such as
 * Safepay, or COD/bank transfer under a custom per-seller rate). Shopify bills
 * it on the merchant's regular Shopify invoice, NOT out of any sales balance,
 * so each fee accrues on its ledger row (`Transaction.metadata.billing`) and
 * is collected here with a real Stripe invoice against the seller's saved
 * payment method (see TransactionFeeBillingService).
 */
@Schema({ timestamps: true })
export class TransactionFeeBill {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  /** 'YYYY-MM' of the month the fees accrued in. One bill per (store, month). */
  @Prop({ type: String, required: true }) periodKey: string;

  /** Billed in USD (platform plans are USD). */
  @Prop({ type: Number, default: 0 }) amountUSD: number;
  @Prop({ type: Number, default: 0 }) saleCount: number;

  /** Per-sale-currency detail: what accrued natively and its USD value at billing time. */
  @Prop({ type: [Object], default: [] }) breakdown: Array<{ currency: string; amount: number; amountUSD: number; saleCount: number }>;

  @Prop({ type: String, enum: ['creating', 'invoiced', 'paid', 'payment_failed', 'failed'], default: 'creating' }) status: string;
  @Prop({ type: String, default: null }) stripeInvoiceId: string | null;
  @Prop({ type: String, default: null }) hostedInvoiceUrl: string | null;
  @Prop({ type: Date, default: null }) paidAt: Date | null;
  @Prop({ type: String, default: null }) failureReason: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const TransactionFeeBillSchema = SchemaFactory.createForClass(TransactionFeeBill);
TransactionFeeBillSchema.index({ storeId: 1, periodKey: 1 }, { unique: true });
TransactionFeeBillSchema.index({ storeId: 1, createdAt: -1 });
TransactionFeeBillSchema.index({ stripeInvoiceId: 1 });
TransactionFeeBillSchema.index({ status: 1, createdAt: -1 });
