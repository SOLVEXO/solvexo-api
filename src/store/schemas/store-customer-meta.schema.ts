/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreCustomerMetaDocument = HydratedDocument<StoreCustomerMeta>;

/**
 * Seller-private metadata about one buyer, scoped to ONE store — a "customer"
 * in this app has no platform-wide profile of its own (see `getStoreCustomers`
 * in `store.service.ts`, which derives the customer list from `Order`), so
 * tags/notes are naturally per-store too: a note a seller leaves about a
 * buyer on Store A must never leak into Store B's view of that same buyer.
 * Segmentation itself (New/Returning/VIP/At Risk) is NOT stored here — it's
 * computed at read time in `getStoreCustomers` from real order stats
 * (orderCount/totalSpent/lastOrderAt), since a stored label would just go
 * stale the moment the buyer's next order changes which bucket they're in.
 */
@Schema({ timestamps: true })
export class StoreCustomerMeta {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, index: true })
  userId: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ type: String, default: '' })
  notes: string;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreCustomerMetaSchema = SchemaFactory.createForClass(StoreCustomerMeta);

StoreCustomerMetaSchema.index({ storeId: 1, userId: 1 }, { unique: true });
