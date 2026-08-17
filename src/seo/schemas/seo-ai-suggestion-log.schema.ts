/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoAiSuggestionLogDocument = SeoAiSuggestionLog & Document;

@Schema({ timestamps: true })
export class SeoAiSuggestionLog {
  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: String, required: true })
  sellerId: string;

  @Prop({ type: String, enum: ['product', 'category', 'store'], required: true })
  entityType: string;

  @Prop({ type: String, required: true })
  entityId: string;

  @Prop({ type: Object, required: true })
  suggestion: { metaTitle: string; metaDescription: string; keywords: string[] };

  @Prop({ type: Boolean, default: false })
  accepted: boolean;

  @Prop({ type: Number, required: true })
  creditsCost: number;
}

export const SeoAiSuggestionLogSchema = SchemaFactory.createForClass(SeoAiSuggestionLog);
SeoAiSuggestionLogSchema.index({ storeId: 1, createdAt: -1 });
SeoAiSuggestionLogSchema.index({ storeId: 1, entityType: 1, entityId: 1 });
