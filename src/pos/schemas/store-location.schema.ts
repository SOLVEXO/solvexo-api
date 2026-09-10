/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreLocationDocument = StoreLocation & Document;

/**
 * A physical branch/outlet under one Store (e.g. "North Karachi", "Orangi
 * Town", "Five Star"). One Store stays one online marketplace listing;
 * StoreLocation was originally POS-only (registers, employees, sales,
 * reporting) — now ALSO doubles as a real Inventory location once a store
 * creates 2+ of them: `VariantLocationStock` tracks per-location stock,
 * and `ProductVariant.stock` becomes the auto-maintained sum across every
 * location. Still never affects products/orders/checkout directly — those
 * keep reading the one aggregate `ProductVariant.stock` field regardless
 * of how many locations exist behind it.
 *
 * Registers/Employees/Sales predating this feature have `locationId: null`
 * and are grouped under an implicit "Unassigned" bucket in reports rather
 * than requiring a data migration.
 */
@Schema({ timestamps: true })
export class StoreLocation {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: String, required: true }) name: string; // "North Karachi"
  @Prop({ type: String, default: null }) addressLine1: string | null;
  @Prop({ type: String, default: null }) city: string | null;
  @Prop({ type: String, default: null }) phone: string | null;

  // The location a new variant's existing (pre-multi-location) stock is
  // assigned to the first time it's ever split by location — exactly one
  // location per store should carry this at a time (enforced in
  // StoreLocationService, not at the schema level).
  @Prop({ default: false }) isDefault: boolean;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: string;
  @Prop({ default: false }) isDelete: boolean;
}

export const StoreLocationSchema = SchemaFactory.createForClass(StoreLocation);
StoreLocationSchema.index({ storeId: 1, status: 1 });
StoreLocationSchema.index({ sellerId: 1 });
