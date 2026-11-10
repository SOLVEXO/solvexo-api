/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/** One declarative checkout rule of a store (see checkout-rules.util.ts for the allowed fields / operators / actions). */
@Schema({ timestamps: true, collection: 'checkoutrules' })
export class CheckoutRule {
  @Prop({ type: String, required: true }) storeId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 80 }) name: string;
  @Prop({ type: String, enum: ['discount', 'payment', 'shipping', 'validation'], required: true }) type: 'discount' | 'payment' | 'shipping' | 'validation';
  @Prop({ type: String, enum: ['active', 'draft'], default: 'draft' }) status: 'active' | 'draft';
  /** Lower runs first. */
  @Prop({ type: Number, default: 100 }) priority: number;
  @Prop({ type: [{ _id: false, field: String, op: String, value: Object }], default: [] }) conditions: { field: string; op: string; value: any }[];
  @Prop({ type: Object, required: true }) action: Record<string, any>;
}
export type CheckoutRuleDocument = CheckoutRule & Document;
export const CheckoutRuleSchema = SchemaFactory.createForClass(CheckoutRule);
CheckoutRuleSchema.index({ storeId: 1, type: 1, status: 1, priority: 1 });
