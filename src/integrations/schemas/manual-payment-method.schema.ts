/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ManualPaymentMethodDocument = ManualPaymentMethod & Document;

/**
 * Shopify "Manual payment methods > Create custom payment method": a seller-named way of paying that the platform
 * never touches (Easypaisa to my number, pay at pickup, cheque...). Shown at checkout with its instructions; the
 * order is placed UNPAID and stays pending until the seller marks it paid. No fee (rail `manual`, CORE RULE 2d).
 * Any number per store, all active ones are offered.
 */
@Schema({ timestamps: true })
export class ManualPaymentMethod {
  @Prop({ type: String, required: true, index: true })
  storeId: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 60 })
  name: string;

  /** Shown to the buyer at checkout and on the order confirmation. */
  @Prop({ type: String, default: '', maxlength: 2000 })
  instructions: string;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Number, default: 0 })
  sortOrder: number;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const ManualPaymentMethodSchema = SchemaFactory.createForClass(ManualPaymentMethod);
ManualPaymentMethodSchema.index({ storeId: 1, isDelete: 1, isActive: 1, sortOrder: 1 });
// Unique name per store among live methods (Shopify rejects duplicates).
ManualPaymentMethodSchema.index({ storeId: 1, name: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
