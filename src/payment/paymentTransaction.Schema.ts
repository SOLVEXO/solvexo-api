import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PaymentTransactionDocument = HydratedDocument<PaymentTransaction>;

@Schema({ timestamps: true })
export class PaymentTransaction {
  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ type: String, required: true, index: true })
  checkoutId: string;

  // ek payment se bane saare orders (physical + digital)
  @Prop({ type: [String], default: [] })
  orderIds: string[];

  @Prop({ enum: ['cash_on_delivery', 'stripe'], required: true })
  paymentType: string;

  @Prop({ required: true })
  amount: number;

  // 'digital_only' = this Stripe charge covers only a mixed checkout's
  // digital-items subtotal; the physical portion is settled via COD once
  // this payment succeeds. 'full' = charge covers the whole checkout.
  @Prop({ enum: ['full', 'digital_only'], default: 'full' })
  paymentScope: string;

  @Prop({
    enum: ['pending', 'completed', 'failed'],
    default: 'pending',
    index: true,
  })
  status: string;

  @Prop({ type: String, default: null })
  stripePaymentIntentId: string | null;

  @Prop({ type: String, default: null })
  stripeClientSecret: string | null;

  @Prop({ type: Date, default: null })
  paidAt: Date | null;

  @Prop({ default: false })
  isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const PaymentTransactionSchema =
  SchemaFactory.createForClass(PaymentTransaction);

PaymentTransactionSchema.index({ userId: 1 });
PaymentTransactionSchema.index({ checkoutId: 1 });
PaymentTransactionSchema.index({ orderIds: 1 });
PaymentTransactionSchema.index({ stripePaymentIntentId: 1 });
