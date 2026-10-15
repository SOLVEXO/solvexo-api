import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TranslationDocument = Translation & Document;

/**
 * Translation content for a specific locale.
 * Used to store translated versions of fields like title, description, etc.
 */
@Schema()
export class Translation {
  @Prop({ required: true })
  locale: string; // e.g., 'en', 'ur', 'fr'

  @Prop({ required: true })
  title: string;

  @Prop({ type: String, default: null })
  description: string | null;

  @Prop({ type: String, default: null })
  handle: string | null; // Translated slug/URL handle

  @Prop({ type: String, default: null })
  metaTitle: string | null;

  @Prop({ type: String, default: null })
  metaDescription: string | null;
}

export const TranslationSchema = SchemaFactory.createForClass(Translation);
