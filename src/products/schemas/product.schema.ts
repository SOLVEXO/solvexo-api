/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

export enum ProductType {
  PHYSICAL = 'physical',
  DIGITAL = 'digital',
  EDUCATIONAL = 'educational',
}

@Schema({ timestamps: true })
export class Product {

  @Prop({ required: true })
  sellerId: string;

  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, unique: true })
  slug: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({
    type: String,
    enum: Object.values(ProductType),
    required: true,
  })
  productType: ProductType;

  @Prop({ type: String, required: true })
  categoryId: string;

  @Prop({ type: String, default: null })
  subCategoryId: string | null;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  // analytics
  @Prop({ default: 0 })
  viewCount: number;

  @Prop({ default: 0 })
  wishlistCount: number;

  @Prop({ default: 0 })
  purchaseCount: number;

  @Prop({ default: 0 })
  averageRating: number;

  @Prop({ default: 0 })
  ratingSum: number;

  @Prop({ type: Date, default: null })
  lastViewedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastPurchasedAt: Date | null;

  @Prop({ type: Date, default: null })
  lastWishlistedAt: Date | null;

  @Prop({ enum: ['active', 'inactive', 'draft'], default: 'draft' })
  status: string;

  @Prop({ default: false })
  isListedOnSolvexo: boolean;

  @Prop({ default: false })
  isDelete: boolean;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ sellerId: 1 });
ProductSchema.index({ storeId: 1 });
ProductSchema.index({ name: 1 });
ProductSchema.index({ categoryId: 1 });
ProductSchema.index({ productType: 1 });
ProductSchema.index({ purchaseCount: -1 });
ProductSchema.index({ viewCount: -1 });
ProductSchema.index({ tags: 1 });
ProductSchema.index({ status: 1 });
