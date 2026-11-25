/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesEmailTemplateDocument = SalesEmailTemplate & Document;

/** A reusable sales email. `{{name}}`, `{{businessName}}` and `{{senderName}}` are filled in when sent. */
@Schema({ timestamps: true, collection: 'sales_email_templates' })
export class SalesEmailTemplate {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, required: true }) subject: string;
  @Prop({ type: String, required: true }) body: string;
  /** Why it is sent (MESSAGE_REASONS); reps pick a reason, then a template. */
  @Prop({ type: String, default: 'other' }) reason: string;
  @Prop({ type: Boolean, default: false }) isDelete: boolean;
}

export const SalesEmailTemplateSchema =
  SchemaFactory.createForClass(SalesEmailTemplate);
