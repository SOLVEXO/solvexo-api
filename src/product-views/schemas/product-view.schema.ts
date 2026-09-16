/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * Phase 5 — Product Tracking Foundation.
 *
 * One real, timestamped product-detail-page view. This is the tracking
 * infrastructure the "Do not wait until every other analytics tab is
 * finished before creating tracking infrastructure" rule calls for: it must
 * exist and be recording BEFORE any Products-tab metric (view count,
 * view-to-purchase conversion) is built on top of it in Phase 6.
 *
 * `storeId`/`sellerId` are always resolved server-side from the `Product`
 * document at write time (see ProductViewsService.recordView) — NEVER taken
 * from the client — so a spoofed request body can misattribute at worst its
 * own view, never write into another store/seller's analytics.
 *
 * `userId` is set for a logged-in buyer; `anonId` (a client-generated id
 * persisted in localStorage) is used for an anonymous visitor. Exactly one
 * of the two is ever set — there is no third "guest" identity concept here,
 * matching the rest of this codebase's real-identity-only convention.
 *
 * Every count/rate derived from this collection (Phase 6 onward) only covers
 * views recorded from this feature's launch date forward — there is no
 * historical backfill, and nothing should ever pretend otherwise.
 */
@Schema({ timestamps: true })
export class ProductView {
  @Prop({ required: true })
  productId: string;

  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  sellerId: string;

  @Prop({ type: String, default: null })
  userId: string | null;

  @Prop({ type: String, default: null })
  anonId: string | null;

  @Prop({ type: Date, required: true })
  viewedAt: Date;
}

export type ProductViewDocument = ProductView & Document;
export const ProductViewSchema = SchemaFactory.createForClass(ProductView);

// Every read this feature does is "views for this product/store/seller within
// a date range, newest/any first" — never a global unsorted scan.
ProductViewSchema.index({ productId: 1, viewedAt: -1 });
ProductViewSchema.index({ storeId: 1, viewedAt: -1 });
ProductViewSchema.index({ sellerId: 1, viewedAt: -1 });
// Supports the dedup lookup in recordView: "does this identity already have a
// recent view of this product?" — scoped to whichever identity is set.
ProductViewSchema.index({ productId: 1, userId: 1, viewedAt: -1 });
ProductViewSchema.index({ productId: 1, anonId: 1, viewedAt: -1 });
