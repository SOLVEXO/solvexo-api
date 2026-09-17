/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type BookableServiceDocument = BookableService & Document;

/** Plain embedded snapshot shape — follows this codebase's existing pattern for
 * embedded objects (see Payout.payoutMethodSnapshot: `type: Object` + a TS
 * type annotation, not a separately-decorated Mongoose sub-schema class). */
export interface InPersonAddress {
  addressLine1: string;
  city: string;
  phone: string;
}

/**
 * A sellable, bookable appointment offering (e.g. "60-minute consultation",
 * "Home cleaning visit"). Parallel to Product/ProductVariant — a brand-new
 * domain, not built on top of the physical/digital checkout pipeline.
 *
 * `inPersonAddress` is an embedded snapshot, deliberately NOT a reference to
 * POS's `StoreLocation` — that schema documents itself as scoped to POS
 * (registers/employees/sales) only, never products/checkout/bookings.
 */
@Schema({ timestamps: true })
export class BookableService {
  @Prop({ type: String, required: true }) sellerId: string;
  @Prop({ type: String, required: true }) storeId: string;

  @Prop({ type: String, required: true }) name: string;
  @Prop({ type: String, required: true }) slug: string;
  @Prop({ type: String, default: '' }) description: string;
  @Prop({ type: [String], default: [] }) images: string[];
  @Prop({ type: String, default: null }) categoryId: string | null;

  @Prop({ type: Number, required: true }) durationMinutes: number;
  @Prop({ type: Number, required: true }) price: number;
  @Prop({ type: String, default: 'USD' }) currency: string;

  @Prop({ type: Number, default: 1 }) capacityPerSlot: number;
  @Prop({ type: Number, default: 24 }) cancellationWindowHours: number;

  @Prop({ type: [String], enum: ['in_person', 'virtual', 'customer_address'], default: [] })
  locationTypes: string[];

  // Embedded snapshot — see interface doc comment above for why this is NOT a
  // StoreLocation reference.
  @Prop({ type: Object, default: null })
  inPersonAddress: InPersonAddress | null;

  @Prop({ type: String, enum: ['active', 'inactive', 'draft'], default: 'draft' }) status: string;
  @Prop({ default: false }) isDelete: boolean;
}

export const BookableServiceSchema = SchemaFactory.createForClass(BookableService);
BookableServiceSchema.index({ storeId: 1, status: 1 });
BookableServiceSchema.index({ sellerId: 1 });
