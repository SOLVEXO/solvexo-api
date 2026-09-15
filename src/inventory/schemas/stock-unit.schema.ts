/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StockUnitDocument = StockUnit & Document;

export const STOCK_UNIT_STATUSES = ['in_stock', 'sold', 'returned', 'damaged'] as const;
export type StockUnitStatus = (typeof STOCK_UNIT_STATUSES)[number];

/** Real per-unit serial-number tracking — OPT-IN per variant via
 *  `ProductVariant.trackSerials` (default false; electronics/high-value-
 *  goods sellers are the realistic audience, matching this pass's own
 *  "industry-dependent" framing for lot/serial tracking generally). One row
 *  per PHYSICAL unit, created at Purchase Order receiving time (the
 *  receiving form asks for N serial numbers when receiving N units of a
 *  serial-tracked variant).
 *
 *  Deliberately NOT wired into cart/checkout/POS scan-to-sell — a buyer
 *  picking a specific serial at add-to-cart time would touch cart/checkout/
 *  POS far beyond this pass's realistic scope. Instead, serial ASSIGNMENT
 *  happens at FULFILLMENT time: when a seller marks a physical order line
 *  "shipped" (OrdersService.updateSellerOrderStatus), and the line's variant
 *  is serial-tracked, the seller picks which in-stock serial(s) fulfilled
 *  it — a real, disclosed, scoped design (asset assignment at pack time,
 *  not cart time), not a missing feature. */
@Schema({ timestamps: true })
export class StockUnit {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, default: null }) locationId: string | null;
  @Prop({ type: String, default: null }) lotId: string | null;

  @Prop({ type: String, required: true }) serialNumber: string;
  @Prop({ type: String, enum: STOCK_UNIT_STATUSES, default: 'in_stock' }) status: StockUnitStatus;

  @Prop({ type: String, default: null }) purchaseOrderId: string | null;
  @Prop({ type: String, default: null }) orderId: string | null; // set once assigned to a real sale at fulfillment time
  @Prop({ type: String, default: null }) sellerOrderItemId: string | null;
  @Prop({ type: Date, default: null }) soldAt: Date | null;
}

export const StockUnitSchema = SchemaFactory.createForClass(StockUnit);
StockUnitSchema.index({ variantId: 1, serialNumber: 1 }, { unique: true });
StockUnitSchema.index({ variantId: 1, status: 1 });
StockUnitSchema.index({ storeId: 1 });
