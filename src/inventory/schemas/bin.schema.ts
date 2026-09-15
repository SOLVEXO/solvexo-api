/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BinDocument = Bin & Document;

/** Real bin/shelf-level granularity WITHIN one `StoreLocation` — a seller
 *  running an actual warehouse (not just a retail-floor `StoreLocation`)
 *  can name real pick spots (Zone A / Aisle 3 / Shelf B2) instead of only
 *  knowing "50 units are somewhere at the Warehouse". Deliberately shallow
 *  (Zone/Aisle/Shelf as free-text strings + one `code`, not a real
 *  Zone→Aisle→Bin hierarchy of its own documents) — a full WMS bin tree
 *  with pick/pack routing is out of scope for this pass; this is the
 *  realistic "know which shelf" depth a mid-size seller actually needs.
 *  `VariantLocationStock.binId` is what actually carries the per-bin
 *  quantity — this schema is just the bin's own identity/metadata. */
@Schema({ timestamps: true })
export class Bin {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) locationId: string;

  // A short human code shown everywhere else in the UI (receiving, transfer
  // receipt, stock lines) — e.g. "A3-B2". Unique per location, not globally.
  @Prop({ type: String, required: true }) code: string;

  @Prop({ type: String, default: null }) zone: string | null;
  @Prop({ type: String, default: null }) aisle: string | null;
  @Prop({ type: String, default: null }) shelf: string | null;

  @Prop({ default: false }) isDelete: boolean;
}

export const BinSchema = SchemaFactory.createForClass(Bin);
BinSchema.index({ locationId: 1, code: 1 }, { unique: true });
BinSchema.index({ storeId: 1 });
