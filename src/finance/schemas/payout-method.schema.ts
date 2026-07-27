import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PayoutMethodDocument = PayoutMethod & Document;

@Schema({ timestamps: true })
export class PayoutMethod {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true }) sellerId: string;

  @Prop({
    type: String,
    enum: ['bank_transfer', 'paypal', 'stripe'],
    required: true,
  })
  type: string;

  @Prop({ type: Boolean, default: false }) isDefault: boolean;

  // Bank transfer fields
  @Prop({ type: String, default: null }) bankName: string | null;
  @Prop({ type: String, default: null }) accountHolder: string | null;
  // Only last 4 digits stored — never store full account number
  @Prop({ type: String, default: null }) accountLast4: string | null;
  @Prop({ type: String, default: null }) routingNumber: string | null;

  // Stripe / PayPal
  @Prop({ type: String, default: null }) externalAccountId: string | null;

  @Prop({
    type: String,
    enum: ['active', 'inactive', 'pending_verification'],
    default: 'active',
  })
  status: string;
}

export const PayoutMethodSchema = SchemaFactory.createForClass(PayoutMethod);
PayoutMethodSchema.index({ storeId: 1 });
PayoutMethodSchema.index({ storeId: 1, isDefault: 1 });
