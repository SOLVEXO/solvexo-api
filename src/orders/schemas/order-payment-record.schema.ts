/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OrderPaymentRecordDocument = HydratedDocument<OrderPaymentRecord>;

/** Real, standalone payment ledger for Shopify's "Record payments"
 *  permission — previously `OrdersService.markPaid()` was a blind boolean
 *  flip with no amount/method/reference captured anywhere. Every entry here
 *  is an immutable record of a specific manually-collected payment (cash,
 *  bank transfer, etc.) against an order — supports multiple partial
 *  entries (installments/deposits), never a single overwritten value.
 *  Deliberately its own collection, not folded into `PaymentTransaction`
 *  (that schema's `checkoutId`/`userId` are required and tightly coupled to
 *  the buyer-initiated Stripe/COD checkout flow — a manual record has no
 *  natural checkout to attach to). */
@Schema({ timestamps: true })
export class OrderPaymentRecord {
  @Prop({ type: String, required: true, index: true })
  orderId: string;

  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: Number, required: true })
  amount: number;

  // Always the order's own currency (Order.currency) — a manual record has
  // no buyer-currency-preference concept to resolve.
  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: String, enum: ['cash', 'bank_transfer', 'other'], required: true })
  method: 'cash' | 'bank_transfer' | 'other';

  @Prop({ type: String, default: null })
  reference: string | null;

  @Prop({ type: String, default: '' })
  note: string;

  @Prop({ type: String, required: true })
  recordedBy: string;

  @Prop({ type: String, enum: ['seller', 'staff', 'admin'], required: true })
  recordedByRole: 'seller' | 'staff' | 'admin';

  createdAt?: Date;
  updatedAt?: Date;
}

export const OrderPaymentRecordSchema = SchemaFactory.createForClass(OrderPaymentRecord);

OrderPaymentRecordSchema.index({ orderId: 1, createdAt: -1 });
OrderPaymentRecordSchema.index({ storeId: 1, createdAt: -1 });
