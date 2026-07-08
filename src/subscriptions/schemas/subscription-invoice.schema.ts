/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionInvoiceDocument = SubscriptionInvoice & Document;

@Schema({ timestamps: true })
export class SubscriptionInvoice {
  @Prop({ type: String, required: true }) subscriptionId: string;
  @Prop({ type: String, required: true }) storeId: string;    // source of truth for ownership
  @Prop({ type: String, required: true }) sellerId: string;   // denormalized
  @Prop({ type: String, required: true }) customerId: string; // denormalized

  @Prop({ type: String, required: true, unique: true }) invoiceNumber: string;

  // 'initial' = first charge on subscribe, 'recurring' = billing-cycle
  // renewal, 'proration' = mid-cycle plan/interval change (may be negative
  // when the change results in an account credit rather than a charge).
  @Prop({ type: String, enum: ['initial', 'recurring', 'proration'], default: 'recurring' }) type: string;

  // Always USD — this is the canonical billing amount. Can be negative for
  // a 'proration' invoice that represents a credit issued, not a charge.
  @Prop({ type: Number, required: true }) amountUSD: number;

  @Prop({ type: String, enum: ['paid', 'failed', 'pending'], default: 'pending' }) status: string;

  @Prop({ type: Date, default: null }) paidAt: Date | null;

  // Will hold Stripe charge/invoice ID once integrated; null for manual provider
  @Prop({ type: String, default: null }) providerChargeId: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionInvoiceSchema = SchemaFactory.createForClass(SubscriptionInvoice);
SubscriptionInvoiceSchema.index({ subscriptionId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ storeId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ sellerId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ invoiceNumber: 1 }, { unique: true });
SubscriptionInvoiceSchema.index({ status: 1 });
