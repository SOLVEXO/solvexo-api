/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MediaAssetDocument = HydratedDocument<MediaAsset>;

// The Files Library — a real, browsable, per-store asset library (Shopify
// "Files"-equivalent), not just the promotional-creative tracker this schema
// started as. `storeId` is the new scoping key for the seller-facing library
// (null for a platform/admin-owned asset, e.g. a platform Banner — same
// ownerType/ownerId split as before, kept for that surface). Every image
// picked through `ImageUpload`'s "Browse Library" option, or uploaded
// through it while a `storeId` is in scope, lands here.
@Schema({ timestamps: true })
export class MediaAsset {
  @Prop({ type: String, enum: ['admin', 'seller'], required: true })
  ownerType: 'admin' | 'seller';

  // sellerId for ownerType 'seller', admin userId for ownerType 'admin'.
  @Prop({ required: true })
  ownerId: string;

  // Per-store scoping for the seller Files Library — null for a
  // pre-Files-Library row (promotional creative, no store context) or a
  // platform-owned asset. Every new upload made through the library always
  // sets this for a seller.
  @Prop({ type: String, default: null, index: true })
  storeId: string | null;

  @Prop({ required: true })
  url: string;

  @Prop({ required: true })
  publicId: string;

  @Prop({ default: 'image' })
  resourceType: string;

  @Prop({ type: Number, default: null })
  width: number | null;

  @Prop({ type: Number, default: null })
  height: number | null;

  @Prop({ type: Number, default: null })
  sizeBytes: number | null;

  @Prop({ type: String, default: null })
  mimeType: string | null;

  @Prop({ type: String, default: '' })
  filename: string;

  @Prop({ type: String, default: '' })
  altText: string;

  @Prop({ type: [String], default: [] })
  tags: string[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const MediaAssetSchema = SchemaFactory.createForClass(MediaAsset);

MediaAssetSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
MediaAssetSchema.index({ storeId: 1, createdAt: -1 });
MediaAssetSchema.index({ storeId: 1, filename: 'text', altText: 'text', tags: 'text' });
