/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { makeAppendOnly } from './pos-immutable.util';
import '../../common/schema-types/minor-money';

export type PosCreditNoteDocument = PosCreditNote & Document;

/** One line of a credit note: what came back from ONE sale line, with its own tax reversal. Snapshot — never re-read from the product. */
@Schema({ _id: false })
export class CreditNoteLine {
  @Prop({ required: true }) saleItemId: string;
  @Prop({ type: String, default: null }) productId: string | null;
  @Prop({ type: String, default: null }) variantId: string | null;
  @Prop({ required: true }) name: string;
  @Prop({ required: true }) sku: string;
  /** PCT / HS code as it was on the SALE line (snapshot at sale time) */
  @Prop({ type: String, default: null }) hsCode: string | null;
  @Prop({ type: String, default: 'standard' }) taxCategory: string;
  @Prop({ type: Number, required: true }) qty: number;
  @Prop({ type: 'MinorMoney' }) unitPriceMinor: number;
  @Prop({ type: 'MinorMoney' }) grossMinor: number;
  @Prop({ type: 'MinorMoney' }) discountMinor: number;
  /** value excluding tax (gross − discount) */
  @Prop({ type: 'MinorMoney' }) netMinor: number;
  /** tax reversed on this line */
  @Prop({ type: 'MinorMoney' }) taxMinor: number;
  @Prop({ type: 'MinorMoney' }) totalMinor: number;
  /** was the stock put back? (a custom item never has stock) */
  @Prop({ type: Boolean, default: true }) restock: boolean;
  @Prop({ type: String, default: null }) restockReason: string | null;
}
export const CreditNoteLineSchema = SchemaFactory.createForClass(CreditNoteLine);

/**
 * A CREDIT NOTE: the document every return and every void produces. Its own per-store gap-free number (CN-000001), linked to the original
 * invoice and lines, with reason, items, quantities, tax and amounts. IMMUTABLE (append-only) — a correction is a new document.
 * Shaped to be transmitted later (see docs/pos-blueprint/FBR_PLAN.md §7/§8): the `fiscal` block is a placeholder; when transmission exists
 * its progress will be appended as events, never written into this record.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PosCreditNote {
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) number: string;
  @Prop({ type: Number, required: true }) seq: number;
  @Prop({ required: true }) saleId: string;
  @Prop({ type: String, default: null }) saleNumber: string | null;
  /** the original tax invoice this note reverses */
  @Prop({ type: String, default: null }) invoiceNumber: string | null;
  @Prop({ type: Date, default: null }) invoiceIssuedAt: Date | null;
  @Prop({ enum: ['return', 'void'], required: true }) kind: string;
  @Prop({ enum: ['partial', 'full'], required: true }) scope: string;
  @Prop({ type: String, default: null }) refundId: string | null;
  @Prop({ type: String, default: null }) reasonCode: string | null;
  @Prop({ type: String, default: null }) reason: string | null;

  @Prop({ type: [CreditNoteLineSchema], default: [] }) lines: CreditNoteLine[];
  @Prop({ type: 'MinorMoney' }) grossMinor: number;
  @Prop({ type: 'MinorMoney' }) discountMinor: number;
  @Prop({ type: 'MinorMoney' }) netMinor: number;
  @Prop({ type: 'MinorMoney' }) taxMinor: number;
  @Prop({ type: 'MinorMoney' }) totalMinor: number;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;
  /** how the money went back, per tender */
  @Prop({ type: [{ _id: false, method: String, amountMinor: { type: 'MinorMoney' } }], default: [] })
  tenders: Array<{ method: string; amountMinor: number }>;

  /** seller as registered (snapshot of the store tax profile at the time) */
  @Prop({ type: Object, default: null }) seller: { legalName: string | null; address: string | null; ntn: string | null; strn: string | null } | null;
  @Prop({ type: String, default: null }) customerName: string | null;

  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  /** why a manager was needed (empty when none) */
  @Prop({ type: [String], default: [] }) approvalReasons: string[];
  /** the REFUNDING till and shift — the drawer / terminal that paid (G3.0). Null when no shift was open (card-only fallback). */
  @Prop({ type: String, default: null }) registerId: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  /** the ORIGINAL sale's till and shift (G3.0) — can differ from the refunding ones */
  @Prop({ type: String, default: null }) saleRegisterId: string | null;
  @Prop({ type: String, default: null }) saleSessionId: string | null;
  /** set only on a note created by the one-off backfill of pre-G2.5 refunds / voids (series `CN-B…`, negative `seq`) */
  @Prop({ type: Object, default: null }) backfill: { backfilledAt: Date; originalType: 'refund' | 'void'; originalId: string; batchId: string; amountDeltaMinor?: number } | null;

  /** FBR placeholders — empty / pending for now (FBR_PLAN.md). */
  @Prop({ type: Object, default: () => ({ status: 'not_enabled', externalInvoiceNumber: null, qrPayload: null, attempts: 0, lastError: null }) })
  fiscal: { status: string; externalInvoiceNumber: string | null; qrPayload: string | null; attempts: number; lastError: string | null };
}

export const PosCreditNoteSchema = SchemaFactory.createForClass(PosCreditNote);
PosCreditNoteSchema.set('toJSON', { getters: true, virtuals: false });
PosCreditNoteSchema.set('toObject', { getters: true, virtuals: false });

PosCreditNoteSchema.index({ storeId: 1, seq: 1 }, { unique: true, name: 'uniq_cn_seq_per_store' });
PosCreditNoteSchema.index({ storeId: 1, number: 1 }, { unique: true, name: 'uniq_cn_number_per_store' });
PosCreditNoteSchema.index({ saleId: 1, createdAt: 1 });
PosCreditNoteSchema.index({ refundId: 1 }, { unique: true, partialFilterExpression: { refundId: { $type: 'string' } }, name: 'uniq_cn_refund' });
PosCreditNoteSchema.index({ storeId: 1, createdAt: -1 });

makeAppendOnly(PosCreditNoteSchema);
