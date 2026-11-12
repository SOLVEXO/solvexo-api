/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import '../../common/schema-types/minor-money';
import { makeAppendOnly } from '../../pos/schemas/pos-immutable.util';

export type PurchaseReceiptDocument = PurchaseReceipt & Document;

@Schema({ _id: true })
export class PurchaseReceiptLine {
  @Prop({ type: String, default: null }) poItemId: string | null;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) sku: string | null;
  @Prop({ type: Number, required: true }) qtyGood: number;
  @Prop({ type: Number, default: 0 }) qtyDamaged: number;
  /** the cost of ONE unit on this receipt (the PO line's cost, or the manager's own for a receipt without a PO) */
  @Prop({ type: 'MinorMoney', required: true }) unitCostMinor: number;
  @Prop({ type: 'MinorMoney', required: true }) lineTotalMinor: number;
  @Prop({ type: String, default: null }) lotId: string | null;
  @Prop({ type: String, default: null }) lotNumber: string | null;
  @Prop({ type: Date, default: null }) expiryDate: Date | null;
  /** how many of the good units have gone back to the supplier since (receipts stay append-only; the return documents hold the detail) — derived on read, never stored */
}
export const PurchaseReceiptLineSchema = SchemaFactory.createForClass(PurchaseReceiptLine);

/**
 * G3.4: one goods receipt (GRN). APPEND-ONLY — a mistake is corrected by a supplier return or an adjustment, never by editing the receipt.
 * Money is minor units only (the store currency + exponent are stored with it). A receipt against a purchase order points at it;
 * a receipt without a PO (manager only) has `purchaseOrderId = null` and carries its own supplier + costs.
 */
@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class PurchaseReceipt {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) receiptNumber: string;
  @Prop({ type: Number, required: true }) seq: number;
  @Prop({ type: String, default: null }) purchaseOrderId: string | null;
  @Prop({ type: String, default: null }) poNumber: string | null;
  @Prop({ type: String, default: null }) supplierId: string | null;
  @Prop({ type: String, required: true }) supplierName: string;
  @Prop({ type: String, default: null }) locationId: string | null;
  @Prop({ type: [PurchaseReceiptLineSchema], default: [] }) lines: PurchaseReceiptLine[];
  @Prop({ type: String, required: true }) currency: string;
  @Prop({ type: Number, required: true }) currencyExponent: number;
  /** what the supplier is owed for this receipt: Σ (good + damaged) × unit cost — damaged units are credited back by a supplier return */
  @Prop({ type: 'MinorMoney', required: true }) totalMinor: number;
  @Prop({ type: String, default: null }) supplierInvoiceNumber: string | null;
  @Prop({ type: Date, default: null }) supplierInvoiceDate: Date | null;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: String, default: null }) requestId: string | null;
  @Prop({ type: String, default: null }) employeeId: string | null;
  @Prop({ type: String, default: null }) deviceId: string | null;
  createdAt?: Date;
}
export const PurchaseReceiptSchema = SchemaFactory.createForClass(PurchaseReceipt);
PurchaseReceiptSchema.set('toJSON', { getters: true, virtuals: false });
PurchaseReceiptSchema.set('toObject', { getters: true, virtuals: false });
PurchaseReceiptSchema.index({ storeId: 1, createdAt: -1 });
PurchaseReceiptSchema.index({ storeId: 1, seq: 1 }, { unique: true });
PurchaseReceiptSchema.index({ storeId: 1, purchaseOrderId: 1 });
PurchaseReceiptSchema.index({ storeId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
makeAppendOnly(PurchaseReceiptSchema);
