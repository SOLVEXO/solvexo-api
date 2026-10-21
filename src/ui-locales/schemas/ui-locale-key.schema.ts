/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UiLocaleKeyDocument = UiLocaleKey & Document;

/** One storefront label translated on demand for a language whose bundle did not have it yet (a key added after the bundle was made). */
@Schema({ timestamps: true })
export class UiLocaleKey {
  @Prop({ required: true }) locale: string;
  @Prop({ required: true }) key: string;
  @Prop({ required: true, maxlength: 600 }) value: string;
}

export const UiLocaleKeySchema = SchemaFactory.createForClass(UiLocaleKey);
UiLocaleKeySchema.index({ locale: 1, key: 1 }, { unique: true });
