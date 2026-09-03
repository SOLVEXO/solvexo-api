import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PlatformTestimonialDocument = HydratedDocument<PlatformTestimonial>;

export const PLATFORM_TESTIMONIAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type PlatformTestimonialStatus = (typeof PLATFORM_TESTIMONIAL_STATUSES)[number];

// A seller's review of the Solvexo platform itself (not a buyer's review of a
// store/product — that's the separate `Rating` collection, seller-managed on
// their own storefront). Two ways in: an admin types one in directly (goes
// live immediately, `status: 'approved'`) — the original Shopify/BigCommerce
// "customer stories" model — or a seller submits their own via their
// dashboard, which starts `status: 'pending'`/`isActive: false` and stays
// invisible on the homepage until an admin approves it (same moderation
// shape as `BlogComment`). `sellerId`/`storeId` are real relations, set only
// from the authenticated seller's own account at submission time — never
// trusted from client input, so a seller can't submit a quote under a
// different name/store.
@Schema({ timestamps: true })
export class PlatformTestimonial {
  _id: string;

  @Prop({ required: true, trim: true })
  sellerName: string;

  @Prop({ type: String, trim: true, default: null })
  storeName: string | null;

  @Prop({ type: String, default: null, index: true })
  sellerId: string | null;

  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, enum: PLATFORM_TESTIMONIAL_STATUSES, default: 'approved', index: true })
  status: PlatformTestimonialStatus;

  @Prop({ type: String, enum: ['admin', 'seller'], default: 'admin' })
  submittedBy: 'admin' | 'seller';

  @Prop({ required: true, min: 1, max: 5 })
  rating: number;

  @Prop({ required: true, trim: true })
  text: string;

  @Prop({ default: true })
  isVerifiedSeller: boolean;

  @Prop({ default: 0, min: 0 })
  order: number;

  @Prop({ default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PlatformTestimonialSchema = SchemaFactory.createForClass(PlatformTestimonial);

PlatformTestimonialSchema.index({ isActive: 1 });
PlatformTestimonialSchema.index({ order: 1 });

PlatformTestimonialSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
