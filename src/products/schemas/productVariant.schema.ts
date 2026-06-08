/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductVariantDocument = ProductVariant & Document;

@Schema({ timestamps: true })
export class ProductVariant {

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ required: true })
  sku: string;

  @Prop({ required: true })
  price: number;

  @Prop({ type: Number, default: null })
  compareAtPrice!: number | null;

  // physical only
  @Prop({ type: String, default: null })
  size!: string | null;

  @Prop({ type: String, default: null })
  color!: string | null;

  @Prop({ default: 0 })
  stock: number;

  @Prop({ type: String, default: null })
  shippingWeight!: string | null;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ default: false })
  isDefault!: boolean;

  @Prop({ enum: ['active', 'inactive'], default: 'active' })
  status!: string;

  @Prop({ default: false })
  isDelete!: boolean;
}

export const ProductVariantSchema = SchemaFactory.createForClass(ProductVariant);

ProductVariantSchema.index({ productId: 1 });
ProductVariantSchema.index({ sku: 1 });