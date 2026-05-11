import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CartDocument = Cart & Document;

// Embedded subdocument for cart items
@Schema({ _id: false })
export class CartItem {

  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  productVariantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, min: 1 })
  quantity: number;

  @Prop({ required: true })
  price: number;

  // ✅ FIXED: images as array with safe default
  @Prop({ type: [String], default: [] })
  images: string[];
}

export const CartItemSchema = SchemaFactory.createForClass(CartItem);

// Main Cart schema
@Schema({ timestamps: true })
export class Cart {

  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: [CartItemSchema], default: [] })
  items: CartItem[];

  @Prop({ default: 0 })
  totalItems: number;

  @Prop({ default: 0 })
  totalPrice: number;

  @Prop({ default: "active" })
  status: string;

  @Prop({ default: false })
  isDelete: boolean;
}

export const CartSchema = SchemaFactory.createForClass(Cart);