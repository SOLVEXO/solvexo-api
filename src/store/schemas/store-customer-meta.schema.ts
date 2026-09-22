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

  // Seller-side archive of a customer from their default Customers view —
  // purely a per-store visibility flag, never affects the buyer's account.
  @Prop({ type: Boolean, default: false })
  isArchived: boolean;

  // Per-store marketing-email consent, set by the seller on the customer's
  // behalf (e.g. after a phone/in-person opt-in) — intentionally NOT the
  // buyer's own global preference, since a buyer may want emails from one
  // store's seller but not another's.
  @Prop({ type: Boolean, default: false })
  marketingOptIn: boolean;

  // Platform-admin-only: blocks this one buyer from checking out at this one
  // store, without touching their account elsewhere (AdminUsersService.suspend
  // is the separate, platform-wide ban — a seller may own many stores, and a
  // problem with one store's customer shouldn't lock them out of the rest of
  // the platform). Enforced in CheckoutService.createCheckout. Sellers never
  // set this themselves — only StoreService.setCustomerBlockedAdmin does.
  @Prop({ type: Boolean, default: false })
  isBlocked: boolean;

  // Real GDPR "right to erasure" marker — set by StoreService.eraseCustomerData.
  // Scoped to what this ONE store actually holds (this row's own tags/notes,
  // plus this store's own Order.shippingAddress snapshots) — never the shared
  // global `User` identity, which isn't this store's data to erase and may
  // still be the buyer's real login for other stores. See that method's own
  // doc comment for the full boundary.
  @Prop({ type: Boolean, default: false })
  isErased: boolean;

  @Prop({ type: Date, default: null })
  erasedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreCustomerMetaSchema = SchemaFactory.createForClass(StoreCustomerMeta);

StoreCustomerMetaSchema.index({ storeId: 1, userId: 1 }, { unique: true });
