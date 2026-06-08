import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CheckoutDocument = Checkout & Document;

@Schema({ _id: false })
export class CheckoutItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, required: true })
  variantId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;
}

export const CheckoutItemSchema = SchemaFactory.createForClass(CheckoutItem);

@Schema({ timestamps: true })
export class Checkout {
  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  addressId: string;

  @Prop({ type: String, default: null })
  shippingOptionId: string | null;

  @Prop({ type: String, default: null })
  paymentMethodId: string | null;

  @Prop({ type: [CheckoutItemSchema], default: [] })
  items: CheckoutItem[];

  @Prop({ default: 0 })
  subtotal: number;

  @Prop({ default: 0 })
  shippingFee: number;

  @Prop({ default: 0 })
  taxAmount: number;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({
    enum: ['pending', 'payment_pending', 'completed', 'expired', 'cancelled'],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date, default: null })
  expiredAt: Date | null;

  @Prop({ default: false })
  isDelete: boolean;
}

export const CheckoutSchema = SchemaFactory.createForClass(Checkout);

CheckoutSchema.index({ userId: 1 });
CheckoutSchema.index({ addressId: 1 });
CheckoutSchema.index({ shippingOptionId: 1 });
CheckoutSchema.index({ paymentMethodId: 1 });
CheckoutSchema.index({ status: 1 });
CheckoutSchema.index({ createdAt: -1 });

// nested item search ke liye optional indexes
CheckoutSchema.index({ 'items.productId': 1 });
CheckoutSchema.index({ 'items.variantId': 1 });
CheckoutSchema.index({ 'items.sellerId': 1 });