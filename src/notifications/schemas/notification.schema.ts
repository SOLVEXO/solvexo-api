import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationDocument = Notification & Document;

@Schema({ timestamps: true })
export class Notification {
  @Prop({ required: true })
  recipientId: string;

  @Prop({ required: true, enum: ['user', 'seller'] })
  recipientRole: string;

  /** Which store this notification belongs to — null for an account-wide event with no single store (e.g. a cross-store login/security notice). */
  @Prop({ type: String, default: null })
  storeId: string | null;

  @Prop({ required: true })
  type: string;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  body: string;

  @Prop({ type: Object, default: null })
  data: Record<string, any> | null;

  @Prop({ default: false })
  isRead: boolean;

  @Prop({ type: Date, default: null })
  readAt: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ recipientId: 1, createdAt: -1 });
NotificationSchema.index({ recipientId: 1, isRead: 1 });
NotificationSchema.index({ recipientId: 1, storeId: 1, createdAt: -1 });
NotificationSchema.index({ recipientId: 1, storeId: 1, isRead: 1 });
