/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';
import { makeAppendOnly } from '../../pos/schemas/pos-immutable.util';

export type SupplierLedgerEntryDocument = SupplierLedgerEntry & Document;
export const SUPPLIER_LEDGER_TYPES = ['bill', 'payment', 'credit', 'adjustment'] as const;
export type SupplierLedgerType = (typeof SUPPLIER_LEDGER_TYPES)[number];
export const SUPPLIER_PAYMENT_METHODS = ['cash', 'bank', 'other'] as const;

/**
 * G3.4: the payables ledger — one APPEND-ONLY row per money event with a supplier, in MINOR units only.
 * `amountMinor` is signed from the point of view of what the store OWES: a bill (goods received) is + , a payment and a credit (supplier return) are − .
 * The balance owed to a supplier is Σ amountMinor; nothing is ever edited — a wrong entry is reversed by an `adjustment` row.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class SupplierLedgerEntry {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) supplierId: string;
  @Prop({ type: String, enum: SUPPLIER_LEDGER_TYPES, required: true }) type: SupplierLedgerType;
  @Prop({ type: 'MinorMoney', required: true }) amountMinor: number;
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;
  /** receipt | supplier_return | payment | adjustment — the document that caused it */
  @Prop({ type: String, default: null }) refType: string | null;
  @Prop({ type: String, default: null }) refId: string | null;
  @Prop({ type: String, default: null }) refNumber: string | null;
  @Prop({ type: String, default: null }) purchaseOrderId: string | null;
  /** the supplier's own invoice (bills) — the date the aging counts from when present */
  @Prop({ type: String, default: null }) supplierInvoiceNumber: string | null;
  @Prop({ type: Date, default: null }) supplierInvoiceDate: Date | null;
  /** payments only */
  @Prop({ type: String, enum: [...SUPPLIER_PAYMENT_METHODS, null], default: null }) method: string | null;
  @Prop({ type: String, default: null }) reference: string | null;
  @Prop({ type: String, default: null }) sessionId: string | null;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  /** one logical event → one row: `receipt:<id>`, `return:<id>`, `payment:<requestId>` */
  @Prop({ type: String, required: true }) dedupeKey: string;
  createdAt?: Date;
}
export const SupplierLedgerEntrySchema = SchemaFactory.createForClass(SupplierLedgerEntry);
SupplierLedgerEntrySchema.set('toJSON', { getters: true, virtuals: false });
SupplierLedgerEntrySchema.set('toObject', { getters: true, virtuals: false });
SupplierLedgerEntrySchema.index({ storeId: 1, supplierId: 1, createdAt: 1 });
SupplierLedgerEntrySchema.index({ storeId: 1, dedupeKey: 1 }, { unique: true });
makeAppendOnly(SupplierLedgerEntrySchema);
