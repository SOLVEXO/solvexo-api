/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SubscriptionInvoiceDocument = SubscriptionInvoice & Document;

@Schema({ timestamps: true })
export class SubscriptionInvoice {
  @Prop({ type: String, required: true }) subscriptionId: string;
  @Prop({ type: String, required: true }) sellerId: string;   // denormalized
  @Prop({ type: String, required: true }) customerId: string; // denormalized

  @Prop({ type: String, required: true, unique: true }) invoiceNumber: string;

  // Always USD — this is the canonical billing amount
  @Prop({ type: Number, required: true }) amountUSD: number;

  @Prop({ type: String, enum: ['paid', 'failed', 'pending'], default: 'pending' }) status: string;

  @Prop({ type: Date, default: null }) paidAt: Date | null;

  // Will hold Stripe charge/invoice ID once integrated; null for manual provider
  @Prop({ type: String, default: null }) providerChargeId: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const SubscriptionInvoiceSchema = SchemaFactory.createForClass(SubscriptionInvoice);
SubscriptionInvoiceSchema.index({ subscriptionId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ sellerId: 1, createdAt: -1 });
SubscriptionInvoiceSchema.index({ invoiceNumber: 1 }, { unique: true });
SubscriptionInvoiceSchema.index({ status: 1 });
