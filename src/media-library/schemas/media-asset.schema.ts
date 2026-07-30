/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MediaAssetDocument = HydratedDocument<MediaAsset>;

// Scoped to promotional-creative uploads only (StoreBanner / PromotionRequest /
// platform Banner) — deliberately not wired to every upload site in the app
// (product images, chat attachments, etc.), to avoid scope creep.
@Schema({ timestamps: true })
export class MediaAsset {
  @Prop({ type: String, enum: ['admin', 'seller'], required: true })
  ownerType: 'admin' | 'seller';

  // sellerId for ownerType 'seller', admin userId for ownerType 'admin'.
  @Prop({ required: true })
  ownerId: string;

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

  createdAt?: Date;
  updatedAt?: Date;
}

export const MediaAssetSchema = SchemaFactory.createForClass(MediaAsset);

MediaAssetSchema.index({ ownerType: 1, ownerId: 1, createdAt: -1 });
