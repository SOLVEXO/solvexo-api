import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RewardDocument = Reward & Document;

@Schema({ timestamps: true })
export class Reward {
  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ required: true })
  pointsCost: number;

  @Prop({ required: true, enum: ['fixed_discount', 'free_product'] })
  type: 'fixed_discount' | 'free_product';

  // for fixed_discount
  @Prop({ type: Number, default: null })
  discountValue: number | null;

  // for free_product
  @Prop({ type: String, default: null })
  productId: string | null;

  @Prop({ type: Number, default: null })
  stockLimit: number | null;

  @Prop({ type: Number, default: 0 })
  redeemedCount: number;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Boolean, default: false })
  isDelete: boolean;
}

export const RewardSchema = SchemaFactory.createForClass(Reward);

RewardSchema.index({ storeId: 1, isActive: 1 });
