/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PurchaseOrderDocument = HydratedDocument<PurchaseOrder>;

export const PURCHASE_ORDER_STATUSES = ['draft', 'ordered', 'partially_received', 'received', 'closed_short', 'cancelled'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

@Schema({ _id: true })
export class PurchaseOrderItem {
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) image: string | null;
  @Prop({ type: String, default: null }) sku: string | null;
  @Prop({ type: [{ name: String, value: String }], default: [] }) options: { name: string; value: string }[];

  @Prop({ required: true }) quantityOrdered: number;
  // Accumulates across one or more `receive()` calls (partial shipments) —
  // deliberately allowed to exceed `quantityOrdered` (a real supplier can
  // over-ship; PurchaseOrdersService.receive logs that as a discrepancy
  // note rather than rejecting the receipt outright).
  @Prop({ default: 0 }) quantityReceived: number;
  // Units received but damaged on arrival — credited to the variant's
  // damagedStock pool (never sellable `stock`) and flagged for a possible
  // supplier-return claim, not silently mixed into good stock.
  @Prop({ default: 0 }) quantityDamaged: number;

  @Prop({ required: true }) unitCost: number;
}

export const PurchaseOrderItemSchema = SchemaFactory.createForClass(PurchaseOrderItem);

/** A real Purchase Order — the seller's side of "buy stock from a supplier
 *  and receive it in." Mirrors `DraftOrder`'s shape (snapshotted line
 *  items, a status lifecycle, denormalized totals) since it's the closest
 *  existing analog in this codebase, but converts to real stock on receipt
 *  rather than to a buyer-facing `Order`. Receiving is genuinely
 *  incremental — `receive()` can be called more than once as shipments
 *  arrive in parts — and always writes a real `StockAdjustment` audit row
 *  per line (reason `'purchase_received'`), so a PO's effect on stock shows
 *  up in Inventory's existing per-SKU Stock History for free. */
@Schema({ timestamps: true })
export class PurchaseOrder {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: String, default: null }) supplierId: string | null;
  @Prop({ type: String, required: true }) supplierName: string;

  // Destination StoreLocation for received stock — nullable for a
  // single-location store (receiving just adds to `ProductVariant.stock`
  // directly, same as `InventoryService.adjustStock`'s no-location path).
  @Prop({ type: String, default: null }) locationId: string | null;

  @Prop({ type: [PurchaseOrderItemSchema], default: [] }) items: PurchaseOrderItem[];

  @Prop({ type: String, enum: PURCHASE_ORDER_STATUSES, default: 'draft' }) status: PurchaseOrderStatus;

  @Prop({ type: String, default: '' }) notes: string;
  @Prop({ type: String, required: true }) currency: string;

  // Denormalized/cached on every save (PurchaseOrdersService.recalculate).
  @Prop({ type: Number, default: 0 }) subtotal: number;
  @Prop({ type: Number, default: 0 }) shippingCost: number;
  @Prop({ type: Number, default: 0 }) taxCost: number;
  @Prop({ type: Number, default: 0 }) total: number;

  @Prop({ type: String, required: true }) poNumber: string;

  @Prop({ type: Date, default: null }) expectedAt: Date | null;
  @Prop({ type: Date, default: null }) orderedAt: Date | null;
  @Prop({ type: Date, default: null }) receivedAt: Date | null;
  @Prop({ type: Date, default: null }) cancelledAt: Date | null;

  // Set the first time PurchaseOrdersService.sendOverdueAlerts fires for
  // this PO — prevents re-notifying the seller every single day for as
  // long as a shipment stays overdue (a one-time flag, not a dedupe cache,
  // since "still overdue" is real state that belongs on the PO itself).
  @Prop({ type: Date, default: null }) overdueAlertSentAt: Date | null;

  @Prop({ type: String, required: true }) createdBy: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PurchaseOrderSchema = SchemaFactory.createForClass(PurchaseOrder);
PurchaseOrderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
