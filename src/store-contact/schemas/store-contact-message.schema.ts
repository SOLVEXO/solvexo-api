/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreContactMessageDocument = HydratedDocument<StoreContactMessage>;

export const CONTACT_MESSAGE_STATUSES = ['new', 'read', 'archived'] as const;
export type ContactMessageStatus = (typeof CONTACT_MESSAGE_STATUSES)[number];

/** One message a visitor sent through a store's contact form (the `contact_form` section). */
@Schema({ timestamps: true })
export class StoreContactMessage {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, trim: true, maxlength: 80 })
  name: string;

  @Prop({ required: true, trim: true, lowercase: true, maxlength: 120 })
  email: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 30 })
  phone: string | null;

  @Prop({ required: true, trim: true, maxlength: 3000 })
  message: string;

  @Prop({ type: String, enum: CONTACT_MESSAGE_STATUSES, default: 'new' })
  status: ContactMessageStatus;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreContactMessageSchema = SchemaFactory.createForClass(StoreContactMessage);
StoreContactMessageSchema.index({ storeId: 1, createdAt: -1 });
