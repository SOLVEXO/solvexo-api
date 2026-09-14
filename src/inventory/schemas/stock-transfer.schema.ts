/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StockTransferDocument = StockTransfer & Document;

export const STOCK_TRANSFER_STATUSES = ['in_transit', 'partially_received', 'received', 'cancelled'] as const;
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number];

/** A real, stateful record of moving stock from one physical location to
 *  another — Shopify's own "Transfer" equivalent (only relevant once a
 *  store has 2+ real StoreLocations), including a genuine IN-TRANSIT
 *  state: a real warehouse→store shipment takes days, so stock leaves the
 *  source location immediately (`InventoryService.shipTransfer`) but does
 *  NOT land at the destination until someone actually receives it there
 *  (`InventoryService.receiveTransfer`, supports partial/short receipt the
 *  same way Purchase Order receiving does). While `in_transit`, the shipped
 *  quantity lives in `ProductVariant.inTransitStock` — genuinely owned,
 *  genuinely not sellable at either location (see that field's own doc
 *  comment). `ProductVariant.stock` itself (the aggregate total) is never
 *  touched by a transfer either way — only which location/in-transit
 *  bucket currently holds it changes. */
@Schema({ timestamps: true })
export class StockTransfer {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) productName: string;
  @Prop({ type: String, default: null }) sku: string | null;

  @Prop({ type: String, required: true }) fromLocationId: string;
  @Prop({ type: String, required: true }) fromLocationName: string;
  @Prop({ type: String, required: true }) toLocationId: string;
  @Prop({ type: String, required: true }) toLocationName: string;

  // Quantity shipped at creation time — immutable afterward. `receivedQuantity`
  // accumulates across one or more `receiveTransfer` calls (partial receipt);
  // the transfer is fully settled once `receivedQuantity >= quantity`.
  @Prop({ type: Number, required: true }) quantity: number;
  @Prop({ type: Number, default: 0 }) receivedQuantity: number;

  @Prop({ type: String, enum: STOCK_TRANSFER_STATUSES, default: 'in_transit' })
  status: StockTransferStatus;

  @Prop({ type: Date, default: null }) receivedAt: Date | null;
  @Prop({ type: String, default: null }) receivedBy: string | null;
  @Prop({ type: String, default: null }) receivedByName: string | null;
  @Prop({ type: Date, default: null }) cancelledAt: Date | null;

  @Prop({ type: String, default: null }) note: string | null;

  @Prop({ type: String, required: true }) transferredBy: string;
  @Prop({ type: String, default: null }) transferredByName: string | null;
}

export const StockTransferSchema = SchemaFactory.createForClass(StockTransfer);
StockTransferSchema.index({ storeId: 1, createdAt: -1 });
StockTransferSchema.index({ variantId: 1, createdAt: -1 });
StockTransferSchema.index({ storeId: 1, status: 1 });
