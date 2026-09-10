/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StockAdjustmentDocument = StockAdjustment & Document;

export const STOCK_ADJUSTMENT_REASONS = ['restocked', 'damaged', 'return', 'correction', 'other'] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

/** A real, immutable audit-trail row for every manual stock change made from
 *  the Inventory page — Shopify's own "Inventory History" equivalent. Never
 *  written for a checkout/order-driven decrement (those are a normal,
 *  expected part of selling, not something a seller needs to review) —
 *  only for a seller's own deliberate adjustment (restock, damage, count
 *  correction, etc.), which is the actual thing worth a reviewable history. */
@Schema({ timestamps: true })
export class StockAdjustment {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;

  // Which physical branch this adjustment happened at — null for a
  // single-location store (the overwhelming majority) where this concept
  // doesn't apply at all. See VariantLocationStock/StoreLocation.
  @Prop({ type: String, default: null }) locationId: string | null;

  // Denormalized so history reads don't need a join back to Product/Variant
  // for data that never changes after the fact anyway.
  @Prop({ type: String, required: true }) productName: string;
  @Prop({ type: String, default: null }) sku: string | null;

  @Prop({ type: Number, required: true }) previousStock: number;
  @Prop({ type: Number, required: true }) newStock: number;
  @Prop({ type: Number, required: true }) delta: number;

  @Prop({ type: String, enum: STOCK_ADJUSTMENT_REASONS, required: true })
  reason: StockAdjustmentReason;
  @Prop({ type: String, default: null }) note: string | null;

  @Prop({ type: String, required: true }) adjustedBy: string;
  @Prop({ type: String, default: null }) adjustedByName: string | null;
}

export const StockAdjustmentSchema = SchemaFactory.createForClass(StockAdjustment);
StockAdjustmentSchema.index({ variantId: 1, createdAt: -1 });
StockAdjustmentSchema.index({ storeId: 1, createdAt: -1 });
