/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** Solvexo's OWN FBR digital-invoicing setup (invoices Solvexo issues to sellers for plan fees). One document. */
export type FbrDiSettingsDocument = FbrDiSettings & Document;
@Schema({ timestamps: true })
export class FbrDiSettings {
  @Prop({ type: String, default: 'platform', unique: true }) key: string;
  @Prop({ type: Boolean, default: false }) enabled: boolean;
  @Prop({ type: String, enum: ['sandbox', 'production'], default: 'sandbox' }) mode: string;
  /** Solvexo's province as FBR spells it (reference API 5.1). NTN / legal name / address come from Platform Tax settings. */
  @Prop({ type: String, default: '' }) province: string;
  /** Sandbox only (spec section 9). SN019 = "Services rendered or provided". */
  @Prop({ type: String, default: 'SN019' }) scenarioId: string;
  @Prop({ type: String, default: '' }) hsCode: string;
  @Prop({ type: String, default: 'Numbers, pieces, units' }) uom: string;
  @Prop({ type: String, default: 'Services' }) saleType: string;
  /** Only plan invoices paid after this moment are reported (set when invoicing is first switched on). */
  @Prop({ type: Date, default: null }) enabledSince: Date | null;
  @Prop({ type: Date, default: null }) lastTestAt: Date | null;
  @Prop({ type: Boolean, default: null }) lastTestOk: boolean | null;
  @Prop({ type: String, default: null }) lastTestMessage: string | null;
  /** First 12 hex chars of sha256(sandbox token) used in the last test: a test only counts while the token is the same one. */
  @Prop({ type: String, default: null }) lastTestTokenFp: string | null;
}
export const FbrDiSettingsSchema = SchemaFactory.createForClass(FbrDiSettings);

/** A store's own FBR setup (the seller reports ITS sales to FBR with ITS own token). */
export type StoreFbrSettingsDocument = StoreFbrSettings & Document;
@Schema({ timestamps: true })
export class StoreFbrSettings {
  @Prop({ type: String, required: true, unique: true }) storeId: string;
  @Prop({ type: Boolean, default: false }) enabled: boolean;
  @Prop({ type: String, enum: ['sandbox', 'production'], default: 'sandbox' }) mode: string;
  /** AES-256-GCM (INTEGRATIONS key). Never returned to a client — only "token set" + last 4 characters. */
  @Prop({ type: String, default: null, select: false }) tokenSandboxEnc: string | null;
  @Prop({ type: String, default: null, select: false }) tokenProductionEnc: string | null;
  @Prop({ type: String, default: null }) tokenSandboxHint: string | null;
  @Prop({ type: String, default: null }) tokenProductionHint: string | null;
  @Prop({ type: String, default: '' }) province: string;
  /** Registered business name as FBR knows it; defaults to the store name. */
  @Prop({ type: String, default: '' }) legalName: string;
  @Prop({ type: String, default: 'SN002' }) scenarioId: string;
  /** Used for any product whose variant has no valid HS code of its own. */
  @Prop({ type: String, default: '' }) hsCode: string;
  @Prop({ type: String, default: 'Numbers, pieces, units' }) uom: string;
  @Prop({ type: String, default: 'Goods at standard rate (default)' }) saleType: string;
  @Prop({ type: Date, default: null }) enabledSince: Date | null;
  @Prop({ type: Date, default: null }) lastTestAt: Date | null;
  @Prop({ type: Boolean, default: null }) lastTestOk: boolean | null;
  @Prop({ type: String, default: null }) lastTestMessage: string | null;
}
export const StoreFbrSettingsSchema = SchemaFactory.createForClass(StoreFbrSettings);

// held_rule  = on hold: no verified tax rule for this supply yet (never sent, never treated as zero).
// unknown_outcome = the request may have reached FBR (timeout / 5xx / unreadable answer): NEVER resent automatically, a human decides.
export const FBR_INVOICE_STATUSES = ['pending', 'submitted', 'failed', 'rejected', 'needs_info', 'needs_review', 'skipped', 'held_rule', 'unknown_outcome'] as const;
export type FbrInvoiceStatus = (typeof FBR_INVOICE_STATUSES)[number];

/** One invoice reported (or waiting to be reported) to FBR. */
export type FbrInvoiceDocument = FbrInvoiceRecord & Document;
@Schema({ timestamps: true, collection: 'fbrinvoices' })
export class FbrInvoiceRecord {
  /** Who issues the invoice: Solvexo (plan fees) or the store (its own order). */
  @Prop({ type: String, enum: ['platform', 'store'], required: true }) issuer: string;
  /** 'plan_invoice' (PlatformPlanInvoice) or 'order' (Order). */
  @Prop({ type: String, enum: ['plan_invoice', 'order'], required: true }) source: string;
  @Prop({ type: String, required: true }) sourceId: string;
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, default: '' }) sellerId: string;
  /** 'sale' = the invoice; 'adjustment' = a refund/cancel after reporting: flagged for a human, never auto-filed. */
  @Prop({ type: String, enum: ['sale', 'adjustment'], default: 'sale' }) kind: string;
  @Prop({ type: String, enum: FBR_INVOICE_STATUSES, default: 'pending' }) status: string;
  @Prop({ type: String, enum: ['sandbox', 'production'], default: 'sandbox' }) mode: string;
  @Prop({ type: String, default: '' }) reference: string; // human label: PINV-... or the order number
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
  /** PKR per 1 USD frozen at the first build of a plan invoice, so a retry reports the same rupee amounts. */
  @Prop({ type: Number, default: null }) fxRatePKRPerUSD: number | null;
  @Prop({ type: String, default: null }) invoiceDate: string | null;
  /** Set just before the HTTP call and cleared when the answer is saved. A record still set after the lease ran out lost its worker mid-send: its outcome is unknown. */
  @Prop({ type: Date, default: null }) inFlightAt: Date | null;
  /** When the record first needed information from the user (needs_info is re-checked hourly for 14 days from here). */
  @Prop({ type: Date, default: null }) needsInfoSince: Date | null;
  /** The person was told about the problem (once per record). */
  @Prop({ type: Date, default: null }) notifiedAt: Date | null;
  /** unknown_outcome can be resolved ONCE: either 'filed' (FBR number entered by a person) or 'resend'. */
  @Prop({ type: Date, default: null }) resolvedAt: Date | null;
  @Prop({ type: String, default: null }) resolvedBy: string | null;
  @Prop({ type: String, enum: ['filed', 'resend', null], default: null }) resolution: string | null;
  /** The exact JSON last sent to FBR (no token inside). */
  @Prop({ type: Object, default: null, select: false }) payload: Record<string, unknown> | null;
}
export const FbrInvoiceSchema = SchemaFactory.createForClass(FbrInvoiceRecord);
FbrInvoiceSchema.index({ issuer: 1, source: 1, sourceId: 1, kind: 1 }, { unique: true });
FbrInvoiceSchema.index({ status: 1, nextAttemptAt: 1 });
FbrInvoiceSchema.index({ storeId: 1, createdAt: -1 });
