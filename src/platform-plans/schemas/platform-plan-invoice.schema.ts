/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformPlanInvoiceDocument = PlatformPlanInvoice & Document;

/** Billing record for a store's platform-plan charge — mirrors SubscriptionInvoice's shape for the buyer-billing system. */
@Schema({ timestamps: true })
export class PlatformPlanInvoice {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) platformPlanId: string;

  @Prop({ type: String, required: true, unique: true }) invoiceNumber: string;
  @Prop({ type: String, enum: ['initial', 'recurring', 'proration'], default: 'recurring' }) type: string;

  /** Total the seller paid (plan + Solvexo tax). Refunds are capped on this. */
  @Prop({ type: Number, required: true }) amountUSD: number;
  /** Solvexo's own tax inside `amountUSD`, snapshot from the Stripe invoice (0/absent on older invoices = no tax). */
  @Prop({ type: Number, default: null }) subtotalUSD: number | null;
  @Prop({ type: Number, default: 0 }) taxAmountUSD: number;
  @Prop({ type: Number, default: 0 }) taxRatePercent: number;
  @Prop({ type: String, default: null }) taxLabel: string | null;
  @Prop({ type: String, default: null }) taxCountry: string | null;
  @Prop({ type: String, enum: ['paid', 'failed', 'pending', 'refunded', 'partially_refunded'], default: 'pending' }) status: string;
  @Prop({ type: Date, default: null }) paidAt: Date | null;
  @Prop({ type: Date, default: null }) refundedAt: Date | null;
  @Prop({ type: Number, default: 0 }) refundedAmountUSD: number;
  @Prop({ type: String, default: null }) providerRefundId: string | null;

  @Prop({ type: String, default: null }) providerChargeId: string | null;
  @Prop({ type: String, default: null }) stripeInvoiceId: string | null;
  @Prop({ type: String, default: null }) hostedInvoiceUrl: string | null;
  @Prop({ type: String, default: null }) invoicePdfUrl: string | null;
  @Prop({ type: String, default: null }) paymentMethodType: string | null;
  // Card the payment was made with (best-effort, from the provider) — shown in the seller's billing timeline.
  @Prop({ type: String, default: null }) cardBrand: string | null;
  @Prop({ type: String, default: null }) cardLast4: string | null;
  // Line-by-line breakdown: plan price, credit for the unused part of the old plan, account credit, intro discount, tax.
  // Amounts are signed (credits/discounts negative) and sum to `amountUSD`. Absent on invoices created before this field.
  @Prop({ type: [{ _id: false, kind: String, label: String, amountUSD: Number }], default: [] })
  lineItems: Array<{ kind: 'plan' | 'credit' | 'discount' | 'tax' | 'other'; label: string; amountUSD: number }>;
  @Prop({ type: String, default: null }) refundReason: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const PlatformPlanInvoiceSchema = SchemaFactory.createForClass(PlatformPlanInvoice);
PlatformPlanInvoiceSchema.index({ storeId: 1, createdAt: -1 });
PlatformPlanInvoiceSchema.index({ invoiceNumber: 1 }, { unique: true });
PlatformPlanInvoiceSchema.index({ status: 1 });
PlatformPlanInvoiceSchema.index({ stripeInvoiceId: 1 });
