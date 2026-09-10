/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VariantLocationStockDocument = VariantLocationStock & Document;

/** Per-location stock breakdown for a variant — only ever created/queried
 *  once a store has 2+ real `StoreLocation`s (see that schema's doc
 *  comment — previously POS-only, now dual-purpose). A single-location
 *  store never touches this collection at all: `ProductVariant.stock`
 *  alone stays its single source of truth, exactly as before this schema
 *  existed. When locations ARE in play, `ProductVariant.stock` becomes the
 *  auto-maintained SUM of every row here for that variant — checkout/POS/
 *  cart/CSV all keep reading that one aggregate field unchanged; only the
 *  Inventory page's per-location view and Transfers read/write this
 *  collection directly. */
@Schema({ timestamps: true })
export class VariantLocationStock {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) productId: string;
  @Prop({ type: String, required: true }) variantId: string;
  @Prop({ type: String, required: true }) locationId: string;
  @Prop({ type: Number, default: 0 }) stock: number;
}

export const VariantLocationStockSchema = SchemaFactory.createForClass(VariantLocationStock);
VariantLocationStockSchema.index({ variantId: 1, locationId: 1 }, { unique: true });
VariantLocationStockSchema.index({ storeId: 1 });
