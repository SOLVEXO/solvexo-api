/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { FBR_INVOICE_STATUSES } from './fbr-di.schemas';
import { LEDGER_SOURCE_TYPES } from '../tax-core/legal-invoice.types';

/**
 * The fields every e-invoice record has. Platform records (Solvexo's own invoices) and store records (a seller's own sales) live in
 * TWO collections with TWO services that cannot read each other: a Solvexo record is never mixed with a seller's.
 */
class EinvoiceRecordBase {
  @Prop({ type: String, required: true }) issuer: string;
  @Prop({ type: String, required: true }) source: string;
  @Prop({ type: String, required: true }) sourceId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, default: '' }) sellerId: string;
  /** 'sale' = the invoice; 'adjustment' = a refund/cancel after reporting: flagged for a human, never auto-filed. */
  @Prop({ type: String, enum: ['sale', 'adjustment'], default: 'sale' }) kind: string;
  @Prop({ type: String, enum: FBR_INVOICE_STATUSES, default: 'pending' }) status: string;
  /** Part of the unique key: a sandbox record never blocks a production one and a production one can never be duplicated. */
  @Prop({ type: String, enum: ['sandbox', 'production'], default: 'sandbox' }) mode: string;
  /** Which authority adapter files it (registry key). */
  @Prop({ type: String, default: 'PK_FBR' }) authority: string;
  @Prop({ type: String, default: '' }) reference: string;
  @Prop({ type: Number, default: 0 }) attempts: number;
  @Prop({ type: Date, default: null }) nextAttemptAt: Date | null;
  @Prop({ type: Date, default: null }) lastAttemptAt: Date | null;
  @Prop({ type: String, default: null }) fbrInvoiceNumber: string | null;
  @Prop({ type: String, default: null }) fbrDated: string | null;
  @Prop({ type: String, default: null }) qrText: string | null;
  @Prop({ type: [{ _id: false, code: { type: String, default: null }, message: String, itemSNo: { type: String, default: null } }], default: [] })
  errors: { code: string | null; message: string; itemSNo?: string | null }[];
  @Prop({ type: Boolean, default: false }) authError: boolean;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: 'PKR' }) currency: string;
  @Prop({ type: Number, default: 0 }) netAmount: number;
  @Prop({ type: Number, default: 0 }) taxAmount: number;
  @Prop({ type: Number, default: null }) fxRatePKRPerUSD: number | null;
  @Prop({ type: String, default: null }) invoiceDate: string | null;
  @Prop({ type: Date, default: null }) inFlightAt: Date | null;
  @Prop({ type: Date, default: null }) needsInfoSince: Date | null;
  @Prop({ type: Date, default: null }) notifiedAt: Date | null;
  @Prop({ type: Date, default: null }) resolvedAt: Date | null;
  @Prop({ type: String, default: null }) resolvedBy: string | null;
  @Prop({ type: String, enum: ['filed', 'resend', null], default: null }) resolution: string | null;
  /** Created from the shadow ledger (an eligible row) rather than straight from the source document. */
  @Prop({ type: Boolean, default: false }) viaLedger: boolean;
  @Prop({ type: Object, default: null, select: false }) payload: Record<string, unknown> | null;
}

export type PlatformEinvoiceDocument = PlatformEinvoiceRecord & Document;
@Schema({ timestamps: true, collection: 'platform_einvoice_records' })
export class PlatformEinvoiceRecord extends EinvoiceRecordBase {}
export const PlatformEinvoiceSchema = SchemaFactory.createForClass(PlatformEinvoiceRecord);
PlatformEinvoiceSchema.path('source').validate((v: string) => LEDGER_SOURCE_TYPES.includes(v as any), 'Unknown platform invoice source');
PlatformEinvoiceSchema.index({ source: 1, sourceId: 1, kind: 1, mode: 1 }, { unique: true });
PlatformEinvoiceSchema.index({ status: 1, nextAttemptAt: 1 });
PlatformEinvoiceSchema.index({ storeId: 1, createdAt: -1 });

export type StoreEinvoiceDocument = StoreEinvoiceRecord & Document;
@Schema({ timestamps: true, collection: 'store_einvoice_records' })
export class StoreEinvoiceRecord extends EinvoiceRecordBase {}
export const StoreEinvoiceSchema = SchemaFactory.createForClass(StoreEinvoiceRecord);
StoreEinvoiceSchema.path('source').validate((v: string) => v === 'order', 'Unknown store invoice source');
// Per store as well: two stores' records can never collide even if an id were ever reused.
StoreEinvoiceSchema.index({ storeId: 1, source: 1, sourceId: 1, kind: 1, mode: 1 }, { unique: true });
StoreEinvoiceSchema.index({ status: 1, nextAttemptAt: 1 });
StoreEinvoiceSchema.index({ storeId: 1, createdAt: -1 });
