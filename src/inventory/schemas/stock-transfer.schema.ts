/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StockTransferDocument = StockTransfer & Document;

/** A real, immutable record of moving stock from one physical location to
 *  another — Shopify's own "Transfer" equivalent, only relevant once a
 *  store has 2+ real StoreLocations. Moving stock is always a lateral,
 *  net-zero operation on the variant's total (`ProductVariant.stock` is
 *  untouched by a transfer — only the two `VariantLocationStock` rows
 *  change), so this is purely a tracking/audit record, not a stock-level
 *  adjustment (that's `StockAdjustment`'s job). */
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

  @Prop({ type: Number, required: true }) quantity: number;
  @Prop({ type: String, default: null }) note: string | null;

  @Prop({ type: String, required: true }) transferredBy: string;
  @Prop({ type: String, default: null }) transferredByName: string | null;
}

export const StockTransferSchema = SchemaFactory.createForClass(StockTransfer);
StockTransferSchema.index({ storeId: 1, createdAt: -1 });
StockTransferSchema.index({ variantId: 1, createdAt: -1 });
