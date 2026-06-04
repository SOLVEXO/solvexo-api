import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PaymentTransactionDocument = HydratedDocument<PaymentTransaction>;

@Schema({ timestamps: true })
export class PaymentTransaction {
  @Prop({ type: String, required: true, index: true })
  userId: string;

  @Prop({ type: String, required: true, index: true })
  checkoutId: string;

  @Prop({ type: String, default: null })
  orderId: string | null;

  @Prop({ enum: ['cash_on_delivery', 'stripe'], required: true })
  paymentType: string;

  @Prop({ required: true })
  amount: number;

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
PaymentTransactionSchema.index({ orderId: 1 });
PaymentTransactionSchema.index({ stripePaymentIntentId: 1 });
