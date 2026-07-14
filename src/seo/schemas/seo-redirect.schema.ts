/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoRedirectDocument = SeoRedirect & Document;

/**
 * 301/302 redirect rule — shared between Admin (platform-wide, `storeId:
 * null`) and Seller (store-scoped, `storeId` set) via one collection and one
 * `SeoRedirectsService`, matching how this codebase already shares
 * `analytics/utils/*` between seller and admin analytics.
 */
@Schema({ timestamps: true })
export class SeoRedirect {
  // null = platform-level redirect (admin-managed); set = a specific store's
  // own redirect (seller-managed, gated by customRedirectsAllowed).
  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ type: String, required: true })
  source: string; // path, e.g. "/old-product-slug"

  @Prop({ type: String, required: true })
  destination: string; // relative path or allow-listed absolute URL — validated in SeoRedirectsService

  @Prop({ type: Number, enum: [301, 302], default: 301 })
  statusCode: number;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0 })
  hitCount: number;

  @Prop({ type: Date, default: null })
  lastHitAt: Date | null;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const SeoRedirectSchema = SchemaFactory.createForClass(SeoRedirect);
SeoRedirectSchema.index({ storeId: 1, source: 1 }, { unique: true });
SeoRedirectSchema.index({ storeId: 1, isActive: 1 });
