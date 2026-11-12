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
  /** The person to talk to at this supplier (the supplier name is the company). */
  @Prop({ type: String, default: null }) contactName: string | null;
  @Prop({ type: String, default: null }) city: string | null;
  @Prop({ type: String, default: null }) country: string | null;
  /** Usual days from order to delivery; used to read expected dates and reorder timing. */
  @Prop({ type: Number, default: null }) leadTimeDays: number | null;
  /** Free text such as "Net 30" or "Cash on delivery". */
  @Prop({ type: String, default: null }) paymentTerms: string | null;
  @Prop({ type: String, default: null }) notes: string | null;
  /** G3.4: tax numbers of the supplier (both optional — a small vendor may have none) */
  @Prop({ type: String, default: null }) ntn: string | null;
  @Prop({ type: String, default: null }) strn: string | null;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: 'active' | 'archived';
  /** bumped at the start of a payment transaction so two payments for one supplier serialize (and cannot both spend the same balance) */
  @Prop({ type: Number, default: 0 }) ledgerRev: number;
  @Prop({ default: false }) isDelete: boolean;
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);
SupplierSchema.index({ storeId: 1, status: 1 });
