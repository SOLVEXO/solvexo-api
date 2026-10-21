/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type StoreTextTranslationDocument = StoreTextTranslation & Document;

/**
 * One translated piece of storefront text (a section heading, an announcement, a footer line, an FAQ answer...).
 * `key` addresses the source text (see text-sources.util.ts); the source itself stays untouched on its own record,
 * so a missing translation always falls back to the original text.
 */
@Schema({ timestamps: true })
export class StoreTextTranslation {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true }) locale: string;
  @Prop({ required: true }) key: string;
  @Prop({ required: true, maxlength: 5000 }) value: string;
}

export const StoreTextTranslationSchema = SchemaFactory.createForClass(StoreTextTranslation);
StoreTextTranslationSchema.index({ storeId: 1, locale: 1, key: 1 }, { unique: true });
