/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreBannerDocument = HydratedDocument<StoreBanner>;

export const STORE_BANNER_TYPES = ['hero', 'promotion', 'season', 'collection', 'video'] as const;
export type StoreBannerType = (typeof STORE_BANNER_TYPES)[number];

export const STORE_BANNER_STATUSES = ['draft', 'scheduled', 'active', 'paused', 'expired'] as const;
export type StoreBannerStatus = (typeof STORE_BANNER_STATUSES)[number];

export const STORE_BANNER_LINK_TYPES = ['product', 'category', 'external', 'collection'] as const;
export type StoreBannerLinkType = (typeof STORE_BANNER_LINK_TYPES)[number];

@Schema({ timestamps: true })
export class StoreBanner {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ type: String, enum: STORE_BANNER_TYPES, default: 'hero' })
  type: StoreBannerType;

  @Prop({ required: true })
  imageUrl: string;

  @Prop({ default: '' })
  publicId: string;

  @Prop({ type: String, default: null })
  mobileImageUrl: string | null;

  @Prop({ type: String, default: '' })
  mobilePublicId: string;

  // Seed for future Video Banners — not built/rendered yet, but the field exists
  // so adding video support later doesn't require a schema change.
  @Prop({ type: String, default: null })
  videoUrl: string | null;

  @Prop({ type: String, default: null })
  ctaLabel: string | null;

  @Prop({ type: String, enum: STORE_BANNER_LINK_TYPES, default: 'external' })
  linkType: StoreBannerLinkType;

  @Prop({ type: String, default: null })
  linkTarget: string | null;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: 0 })
  priority: number;

  @Prop({ type: String, enum: STORE_BANNER_STATUSES, default: 'active' })
  status: StoreBannerStatus;

  @Prop({ type: Date, default: null })
  startAt: Date | null;

  @Prop({ type: Date, default: null })
  endAt: Date | null;

  @Prop({ type: String, default: null })
  createdBy: string | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreBannerSchema = SchemaFactory.createForClass(StoreBanner);

StoreBannerSchema.index({ storeId: 1, status: 1, priority: -1, order: 1 });
StoreBannerSchema.index({ status: 1, endAt: 1 });
