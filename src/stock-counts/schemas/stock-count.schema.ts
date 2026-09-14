/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StockCountDocument = HydratedDocument<StockCount>;

export const STOCK_COUNT_STATUSES = ['open', 'completed', 'cancelled'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

@Schema({ _id: true })
export class StockCountItem {
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, default: null }) sku: string | null;
  @Prop({ type: String, required: true }) productName: string;
  @Prop({ type: String, default: null }) image: string | null;

  // Snapshotted the moment the count STARTS — the "book" quantity being
  // verified. Never re-read live during the session, so a sale that
  // happens mid-count doesn't silently move the goalposts the seller is
  // counting against.
  @Prop({ required: true }) systemQty: number;

  // Null until the seller actually counts this line — lets the session UI
  // distinguish "not counted yet" from "counted, matches system" (both 0
  // discrepancy, very different meanings).
  @Prop({ type: Number, default: null }) countedQty: number | null;
}

export const StockCountItemSchema = SchemaFactory.createForClass(StockCountItem);

/** A real stocktake/cycle-count session — Shopify doesn't have a native
 *  equivalent (third-party apps like Stocky cover this), but every serious
 *  large-retailer inventory platform needs one: snapshot system quantities,
 *  walk the floor counting real quantities, review every discrepancy
 *  before it's allowed to touch `ProductVariant.stock` (never a silent
 *  auto-apply). `finish()` writes one `StockAdjustment` per discrepant line
 *  (reason `'correction'`, already the exact reason this codebase's
 *  adjustment schema uses for a manual count fix — no new reason needed). */
@Schema({ timestamps: true })
export class StockCount {
  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  // Null = counting the store's whole (aggregate) stock, not scoped to one
  // branch — the common case for a single-location store.
  @Prop({ type: String, default: null }) locationId: string | null;

  @Prop({ type: [StockCountItemSchema], default: [] }) items: StockCountItem[];

  @Prop({ type: String, enum: STOCK_COUNT_STATUSES, default: 'open' }) status: StockCountStatus;

  @Prop({ type: String, required: true }) startedBy: string;
  @Prop({ type: Date, default: Date.now }) startedAt: Date;
  @Prop({ type: Date, default: null }) completedAt: Date | null;
  @Prop({ type: Date, default: null }) cancelledAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StockCountSchema = SchemaFactory.createForClass(StockCount);
StockCountSchema.index({ storeId: 1, status: 1, createdAt: -1 });
