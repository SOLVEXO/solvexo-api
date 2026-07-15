/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type DeviceTokenDocument = DeviceToken & Document;

@Schema({ timestamps: true })
export class DeviceToken {
  @Prop({ required: true })
  userId: string;

  @Prop({ required: true, enum: ['user', 'seller'] })
  role: string;

  @Prop({ required: true, unique: true })
  fcmToken: string;

  @Prop({ required: true, enum: ['android', 'ios', 'web'] })
  platform: string;

  @Prop({ default: Date.now })
  lastUsedAt: Date;
}

export const DeviceTokenSchema = SchemaFactory.createForClass(DeviceToken);

DeviceTokenSchema.index({ userId: 1 });
