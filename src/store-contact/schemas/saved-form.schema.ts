/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SavedFormDocument = HydratedDocument<SavedForm>;

/** A form the seller saved once to reuse on other pages (the settings of a contact_form section). */
@Schema({ timestamps: true })
export class SavedForm {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, maxlength: 60 })
  name: string;

  @Prop({ type: Object, required: true })
  settings: Record<string, unknown>;
}

export const SavedFormSchema = SchemaFactory.createForClass(SavedForm);
SavedFormSchema.index({ storeId: 1, name: 1 }, { unique: true });
