/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SupplierDocument = Supplier & Document;

/** A seller's own vendor/supplier directory, scoped per store — same simple
 *  CRUD shape as `StoreLocation`. Purchase Orders reference a supplier by
 *  id (nullable — a PO can be created before the supplier record exists, or
 *  for a one-off vendor never formally added). */
@Schema({ timestamps: true })
export class Supplier {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, default: null }) email: string | null;
  @Prop({ type: String, default: null }) phone: string | null;
  @Prop({ type: String, default: null }) address: string | null;
  @Prop({ type: String, default: null }) notes: string | null;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: 'active' | 'archived';
  @Prop({ default: false }) isDelete: boolean;
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);
SupplierSchema.index({ storeId: 1, status: 1 });
