/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PlatformInvoiceDocument = PlatformInvoice & Document;

/**
 * Read-only SHADOW of one paid Solvexo charge (plan invoice, add-on charge, fee bill, ...). It is written only by the ledger sync and
 * never feeds billing, payments or any tax authority. `taxKnown:false` means the source never recorded its tax: tax fields are then null, NOT 0.
 */
@Schema({ timestamps: true, collection: 'platform_invoices' })
export class PlatformInvoice {
  @Prop({ type: String, required: true }) sourceType: string;
  @Prop({ type: String, required: true }) sourceId: string;
  @Prop({ type: String, required: true }) issuerEntityKey: string;

  @Prop({ type: { _id: false, storeId: String, sellerId: { type: String, default: null }, country: { type: String, default: null } }, required: true })
  customer: { storeId: string; sellerId: string | null; country: string | null };

  @Prop({ type: String, default: 'USD' }) currency: string;
  @Prop({ type: Date, required: true }) paidAt: Date;

  @Prop({ type: Boolean, required: true }) taxKnown: boolean;
  /** null = the source has no net figure (e.g. a one-off charge recorded only as tax). */
  @Prop({ type: Number, default: null }) netUSD: number | null;
  /** The tax that was actually charged. null (never 0) when it is not known. */
  @Prop({ type: Number, default: null }) chargedTaxUSD: number | null;
  @Prop({ type: Number, default: null }) totalUSD: number | null;
  @Prop({ type: [{ _id: false, label: { type: String, default: null }, ratePercent: { type: Number, default: null }, amountUSD: Number, country: { type: String, default: null } }], default: null })
  taxLines: Array<{ label: string | null; ratePercent: number | null; amountUSD: number; country: string | null }> | null;

  @Prop({ type: Number, default: 0 }) refundedUSD: number;
  @Prop({ type: String, default: 'paid' }) status: string;

  @Prop({ type: { _id: false, authority: { type: String, default: null }, eligible: Boolean, reason: String }, required: true })
  routing: { authority: string | null; eligible: boolean; reason: string };

  /** What the engine would treat this supply as. Comparison only: it never changes what was charged. */
  @Prop({ type: { _id: false, treatment: String, ratePercent: { type: Number, default: null }, ruleState: { type: String, default: null } }, required: true })
  determination: { treatment: string; ratePercent: number | null; ruleState: string | null };

  @Prop({ type: [String], default: [] }) warnings: string[];
}

export const PlatformInvoiceSchema = SchemaFactory.createForClass(PlatformInvoice);
PlatformInvoiceSchema.index({ sourceType: 1, sourceId: 1 }, { unique: true });
PlatformInvoiceSchema.index({ 'customer.storeId': 1, paidAt: -1 });
PlatformInvoiceSchema.index({ 'routing.eligible': 1, status: 1 });
PlatformInvoiceSchema.index({ issuerEntityKey: 1, paidAt: -1 });
