import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrderDocument = HydratedDocument<Order>;

@Schema({ _id: true })
export class OrderItem {
  @Prop({ type: String, required: true })
  productId: string;

  @Prop({ type: String, default: null })
  variantId: string | null;

  @Prop({ type: String, enum: ['physical', 'digital'], required: true })
  type: string;

  // snapshot fields
  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, default: null })
  image: string | null;

  @Prop({ type: String, default: null })
  sku: string | null;

  @Prop({ type: String, default: null })
  size: string | null;

  @Prop({ type: String, default: null })
  color: string | null;

  @Prop({ type: String, default: null })
  licenseType: string | null;

  @Prop({ required: true })
  quantity: number;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  totalPrice: number;

  // cancel/refund item-level pe
  @Prop({
    type: String,
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ],
    default: 'pending',
  })
  status: string;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, default: null })
  cancelReason: string | null;

  @Prop({ default: 0 })
  refundedAmount: number;
}

export const OrderItemSchema = SchemaFactory.createForClass(OrderItem);

@Schema({ _id: false })
export class OrderTracking {
  @Prop({ type: String, default: null })
  carrier: string | null;

  @Prop({ type: String, default: null })
  trackingNumber: string | null;

  @Prop({ type: String, default: null })
  trackingUrl: string | null;
}

export const OrderTrackingSchema = SchemaFactory.createForClass(OrderTracking);

// ek store ka hissa — status items se derive hota hai
@Schema({ _id: true })
export class SellerOrder {
  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, enum: ['physical', 'digital', 'mixed'], required: true })
  fulfillmentType: string;

  @Prop({ type: [OrderItemSchema], required: true })
  items: OrderItem[];

  @Prop({ required: true, default: 0 })
  subtotal: number;

  // derived from items
  @Prop({
    enum: [
      'pending',
      'processing',
      'shipped',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ],
    default: 'pending',
  })
  status: string;

  @Prop({ type: OrderTrackingSchema, default: null })
  tracking: OrderTracking | null;

  @Prop({ type: Date, default: null })
  shippedAt: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, default: null })
  cancelReason: string | null;
}

export const SellerOrderSchema = SchemaFactory.createForClass(SellerOrder);

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
  @Prop({ type: String, required: true, unique: true })
  orderNumber: string;

  @Prop({ type: String, required: true })
  userId: string;

  @Prop({ type: String, required: true })
  checkoutId: string;

  @Prop({ type: String, default: 'USD' })
  currency: string;

  // har store ka hissa
  @Prop({ type: [SellerOrderSchema], required: true })
  sellerOrders: SellerOrder[];

  // digital-only order me null
  @Prop({ type: OrderShippingAddressSchema, default: null })
  shippingAddress: OrderShippingAddress | null;

  @Prop({ required: true, default: 0 })
  subtotal: number;

  // poore order ka single shipping (destination city rate)
  @Prop({ required: true, default: 0 })
  shippingFee: number;

  @Prop({ required: true, default: 0 })
  taxAmount: number;

  @Prop({ required: true })
  totalAmount: number;

  @Prop({ enum: ['cash_on_delivery', 'stripe'], required: true })
  paymentType: string;

  @Prop({ enum: ['unpaid', 'paid', 'failed', 'refunded'], default: 'unpaid' })
  paymentStatus: string;

  @Prop({ default: false })
  isPaid: boolean;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  // overall derived status
  @Prop({
    enum: [
      'pending',
      'processing',
      'partially_shipped',
      'completed',
      'cancelled',
    ],
    default: 'pending',
  })
  orderStatus: string;

  @Prop({ default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ orderNumber: 1 }, { unique: true });
OrderSchema.index({ userId: 1 });
OrderSchema.index({ checkoutId: 1 });
OrderSchema.index({ 'sellerOrders.sellerId': 1, 'sellerOrders.status': 1 });
OrderSchema.index({ 'sellerOrders.storeId': 1 });
OrderSchema.index({ 'sellerOrders.items.status': 1 });
OrderSchema.index({ paymentStatus: 1 });
OrderSchema.index({ createdAt: -1 });