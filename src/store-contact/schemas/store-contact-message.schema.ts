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

  @Prop({ default: '', trim: true, maxlength: 80 })
  name: string;

  @Prop({ default: '', trim: true, lowercase: true, maxlength: 120 })
  email: string;

  @Prop({ type: String, default: null, trim: true, maxlength: 30 })
  phone: string | null;

  @Prop({ default: '', trim: true, maxlength: 3000 })
  message: string;

  /** Which form it came from (the section's form name, or '' for an unnamed one) and the section itself. */
  @Prop({ default: '', trim: true, maxlength: 60 })
  formName: string;

  @Prop({ default: '' })
  sectionId: string;

  /** When the visitor got the automatic reply (at most one per address per day, so a form cannot be used to mail strangers). */
  @Prop({ type: Date, default: null })
  autoRepliedAt: Date | null;

  /** Every answer of the seller-built form, in the order of the form (label as it was when sent). */
  @Prop({ type: [{ _id: false, id: String, label: String, type: { type: String }, value: String }], default: [] })
  fields: { id: string; label: string; type: string; value: string }[];

  @Prop({ type: String, enum: CONTACT_MESSAGE_STATUSES, default: 'new' })
  status: ContactMessageStatus;

  /** What the store answered from the inbox (newest last). */
  @Prop({ type: [{ _id: false, message: String, sentAt: Date, sentBy: String }], default: [] })
  replies: { message: string; sentAt: Date; sentBy: string }[];

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreContactMessageSchema = SchemaFactory.createForClass(StoreContactMessage);
StoreContactMessageSchema.index({ storeId: 1, createdAt: -1 });
StoreContactMessageSchema.index({ storeId: 1, formName: 1, createdAt: -1 });
StoreContactMessageSchema.index({ storeId: 1, email: 1, autoRepliedAt: 1 });
