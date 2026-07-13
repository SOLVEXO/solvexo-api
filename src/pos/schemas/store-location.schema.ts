/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreLocationDocument = StoreLocation & Document;

/**
 * A physical branch/outlet under one Store (e.g. "North Karachi", "Orangi
 * Town", "Five Star"). One Store stays one online marketplace listing;
 * StoreLocation only affects the POS side (registers, employees, sales,
 * reporting) — never products/orders/checkout, which remain store-wide.
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

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: string;
  @Prop({ default: false }) isDelete: boolean;
}

export const StoreLocationSchema = SchemaFactory.createForClass(StoreLocation);
StoreLocationSchema.index({ storeId: 1, status: 1 });
StoreLocationSchema.index({ sellerId: 1 });
