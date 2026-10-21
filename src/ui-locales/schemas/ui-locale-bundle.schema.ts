/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UiLocaleBundleDocument = UiLocaleBundle & Document;

/** The storefront's buttons and labels in one language that has no bundled file: translated once, then served from here. */
@Schema({ timestamps: true })
export class UiLocaleBundle {
  @Prop({ required: true, unique: true }) locale: string;
  @Prop({ type: String, enum: ['generating', 'ready', 'failed'], default: 'generating' }) status: 'generating' | 'ready' | 'failed';
  /** Nested like storefront.en.json. */
  @Prop({ type: Object, default: null }) strings: Record<string, any> | null;
  @Prop({ type: Date, default: null }) generatingSince: Date | null;
  @Prop({ type: String, default: null }) error: string | null;
  @Prop({ type: Number, default: 0 }) keyCount: number;
}

export const UiLocaleBundleSchema = SchemaFactory.createForClass(UiLocaleBundle);
