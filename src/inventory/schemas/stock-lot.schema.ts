/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StockLotDocument = StockLot & Document;

export const STOCK_LOT_STATUSES = ['active', 'depleted', 'expired'] as const;
export type StockLotStatus = (typeof STOCK_LOT_STATUSES)[number];

/** Real batch/lot tracking — OPT-IN per variant via
 *  `ProductVariant.trackLots` (default false, so the overwhelming majority
 *  of variants keep the simpler weighted-average `costPrice` model
 *  unchanged). Once opted in, every Purchase Order receipt for that variant
 *  creates a NEW lot row (never merges into an existing one, even at the
 *  same cost — a real lot is a distinct receiving event, needed for
 *  genuine FIFO/FEFO consumption and expiry tracking) instead of only
 *  updating the variant's single weighted-average `costPrice`.
 *
 *  Consumption (stock LEAVING a lot-tracked variant) always drains the
 *  OLDEST active lot(s) first — FEFO (earliest `expiryDate`) when any lot
 *  has one set, otherwise plain FIFO (earliest `receivedAt`). This is what
 *  makes `costOfGoodsSold` on a sold order line real accounting-grade COGS
 *  instead of a single blended average. Scoped to the two real stock-
 *  LEAVING paths this pass integrates: `InventoryService.adjustStock`'s
 *  stock-reducing reasons, and the real sale-time decrement in
 *  `OrdersService` (see that service's own doc comment on `consumeLotsFifo`
 *  for the exact integration point and its disclosed scope boundary). */
@Schema({ timestamps: true })
export class StockLot {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, default: null }) locationId: string | null;

  // A seller-visible label — auto-generated ("LOT-<short id>") unless the PO
  // receiving form supplies a real supplier lot/batch number.
  @Prop({ type: String, required: true }) lotNumber: string;
  @Prop({ type: Date, default: null }) expiryDate: Date | null;

  @Prop({ type: Number, required: true }) quantityReceived: number;
  @Prop({ type: Number, required: true }) quantityRemaining: number;
  @Prop({ type: Number, required: true }) costPrice: number; // this lot's own real unit cost, immutable once received

  @Prop({ type: String, default: null }) supplierId: string | null;
  @Prop({ type: String, default: null }) purchaseOrderId: string | null;

  @Prop({ type: Date, default: Date.now }) receivedAt: Date;
  @Prop({ type: String, enum: STOCK_LOT_STATUSES, default: 'active' }) status: StockLotStatus;
}

export const StockLotSchema = SchemaFactory.createForClass(StockLot);
// FIFO/FEFO consumption always queries "active lots for this variant,
// oldest first" — this compound index is what makes that a real indexed
// query, not a full collection scan, at any real SKU/lot volume.
StockLotSchema.index({ variantId: 1, status: 1, expiryDate: 1, receivedAt: 1 });
StockLotSchema.index({ storeId: 1, createdAt: -1 });
