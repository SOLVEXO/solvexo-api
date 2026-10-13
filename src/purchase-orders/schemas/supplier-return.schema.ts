/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierReturnDocument = HydratedDocument<SupplierReturn>;

export const SUPPLIER_RETURN_REASONS = ['damaged', 'defective', 'wrong_item', 'overstock', 'expired', 'other'] as const;
export type SupplierReturnReason = (typeof SUPPLIER_RETURN_REASONS)[number];
export const SUPPLIER_RETURN_CREDIT_STATUSES = ['pending', 'received'] as const;

@Schema({ _id: true })
export class SupplierReturnItem {
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) sku: string | null;
  @Prop({ required: true }) quantity: number;
  /** cost per unit the supplier owes back — from the lot / PO line / variant cost unless the seller overrides it */
  @Prop({ required: true }) unitCost: number;
  @Prop({ type: String, default: null }) lotId: string | null;
  /** true when the units came out of the damaged (unsellable) pool instead of sellable stock */
  @Prop({ type: Boolean, default: false }) fromDamaged: boolean;
  @Prop({ type: String, default: null }) purchaseOrderItemId: string | null;
}
export const SupplierReturnItemSchema = SchemaFactory.createForClass(SupplierReturnItem);

/** Units sent back to a supplier (Shopify has no native equivalent; dedicated inventory tools — Stocky, Zoho — do). Creating
 *  a return removes the stock for real (variant total, location row, lot, damaged pool), writes one StockAdjustment per line
 *  (reason `supplier_return`) and re-weights the variant's average cost, all in one transaction. Only the supplier's CREDIT is
 *  tracked afterwards (`creditStatus`). */
@Schema({ timestamps: true })
export class SupplierReturn {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) returnNumber: string;
  @Prop({ type: String, default: null }) supplierId: string | null;
  @Prop({ type: String, required: true }) supplierName: string;
  @Prop({ type: String, default: null }) purchaseOrderId: string | null;
  @Prop({ type: String, default: null }) locationId: string | null;
  @Prop({ type: String, enum: SUPPLIER_RETURN_REASONS, default: 'other' }) reason: SupplierReturnReason;
  @Prop({ type: String, default: null }) note: string | null;
  @Prop({ type: [SupplierReturnItemSchema], default: [] }) items: SupplierReturnItem[];
  @Prop({ type: Number, default: 0 }) totalCredit: number;
  @Prop({ type: String, enum: SUPPLIER_RETURN_CREDIT_STATUSES, default: 'pending' }) creditStatus: string;
  @Prop({ type: Date, default: null }) creditReceivedAt: Date | null;
  @Prop({ type: String, default: null }) requestId: string | null;
  @Prop({ type: String, required: true }) createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export const SupplierReturnSchema = SchemaFactory.createForClass(SupplierReturn);
SupplierReturnSchema.index({ storeId: 1, createdAt: -1 });
// duplicate-submit protection: one return per client request id per store
SupplierReturnSchema.index({ storeId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
