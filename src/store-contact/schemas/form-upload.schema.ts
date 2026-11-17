/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FormUploadDocument = HydratedDocument<FormUpload>;

/**
 * A file a visitor attached to a form. It sits in PRIVATE storage; the visitor only ever gets back this record's id.
 * It becomes part of a message when the form is sent (`claimedBy`); one never claimed within a day is deleted by the nightly cleanup.
 */
@Schema({ timestamps: true })
export class FormUpload {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true })
  publicId: string;

  @Prop({ required: true })
  resourceType: string;

  @Prop({ required: true, maxlength: 120 })
  fileName: string;

  @Prop({ required: true })
  size: number;

  @Prop({ required: true, maxlength: 80 })
  mimeType: string;

  /** The message that now owns the file, or null while it only waits for the form to be sent ('pending' while a send is claiming it). */
  @Prop({ type: String, default: null })
  claimedBy: string | null;

  /** Set for the files of a Spam message: they go when the message does (30 days). Cleared if the seller rescues the message. */
  @Prop({ type: Date, default: null })
  expiresAt: Date | null;

  createdAt?: Date;
}

export const FormUploadSchema = SchemaFactory.createForClass(FormUpload);
FormUploadSchema.index({ storeId: 1, claimedBy: 1, createdAt: 1 });
FormUploadSchema.index({ expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $type: 'date' } } });
