/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreFollowerDocument = StoreFollower & Document;

@Schema({ timestamps: true })
export class StoreFollower {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  storeId: string;
}

export const StoreFollowerSchema = SchemaFactory.createForClass(StoreFollower);

StoreFollowerSchema.index({ userId: 1, storeId: 1 }, { unique: true });
StoreFollowerSchema.index({ storeId: 1 });
