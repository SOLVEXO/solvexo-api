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

  // Optional bin/shelf granularity WITHIN one location (see Bin schema) —
  // null (the default, and what every pre-existing row implicitly has)
  // means "this location's stock isn't broken down by bin" — the exact
  // same single-row-per-location behavior this collection always had.
  // Once a seller creates real Bins under a location, additional rows for
  // the SAME (variantId, locationId) but a DIFFERENT binId become valid —
  // `ProductVariant.stock`/a location's own total both stay correct because
  // every sum in InventoryService already reduces over every row sharing a
  // variantId (or a variantId+locationId), never assuming exactly one row
  // per location. NOTE: the unique index below changed from
  // `{variantId,locationId}` to `{variantId,locationId,binId}` — a
  // production database created before this field existed needs that old
  // index dropped once (`db.variantlocationstocks.dropIndex('variantId_1_locationId_1')`)
  // so Mongoose can build the new compound one; not run automatically.
  @Prop({ type: String, default: null }) binId: string | null;

  @Prop({ type: Number, default: 0 }) stock: number;
}

export const VariantLocationStockSchema = SchemaFactory.createForClass(VariantLocationStock);
VariantLocationStockSchema.index({ variantId: 1, locationId: 1, binId: 1 }, { unique: true });
VariantLocationStockSchema.index({ storeId: 1 });
VariantLocationStockSchema.index({ locationId: 1, binId: 1 });
