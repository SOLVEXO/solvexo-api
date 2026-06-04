


import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: false })
export class OrderItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, default: null })
  variantId: string | null;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class OrderShippingAddress {
  @Prop({ type: String, required: true })
  recipientName: string;

  @Prop({ type: String, required: true })
  phoneNumber: string;

  @Prop({ type: String, required: true })
  addressLine1: string;

  @Prop({ type: String, default: null })
  addressLine2: string | null;

  @Prop({ type: String, required: true })
  city: string;

  @Prop({ type: String, required: true })
  state: string;

  @Prop({ type: String, required: true })
  zipCode: string;
}

export const OrderShippingAddressSchema =
  SchemaFactory.createForClass(OrderShippingAddress);

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ type: String, required: true, index: true })
  checkoutId: string;

  @Prop({ type: [OrderItemSchema], required: true })
  orderItems: OrderItem[];

  @Prop({ type: OrderShippingAddressSchema, required: true })
  shippingAddress: OrderShippingAddress;

  @Prop({ required: true, default: 0 })
  subtotal: number;

  @Prop({ required: true, default: 0 })
  shippingFee: number;

  @Prop({ required: true, default: 0 })
  taxAmount: number;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ enum: ['cash_on_delivery', 'stripe'], required: true })
  paymentType: string;

  @Prop({
    enum: ['unpaid', 'paid', 'failed'],
    default: 'unpaid',
    index: true,
  })
  paymentStatus: string;

  @Prop({ default: false })
  isPaid: boolean;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  @Prop({
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
    default: 'pending',
    index: true,
  })
  orderStatus: string;

  @Prop({ default: false })
  isDelivered: boolean;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ userId: 1 });
OrderSchema.index({ checkoutId: 1 });
OrderSchema.index({ orderStatus: 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ createdAt: -1 });