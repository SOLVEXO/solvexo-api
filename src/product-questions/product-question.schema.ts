/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const QUESTION_STATUSES = ['pending', 'published', 'hidden'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** A shopper's question on a product page, and the seller's answer. Shown publicly only once answered and published. */
@Schema({ timestamps: true, collection: 'product_questions' })
export class ProductQuestion {
  @Prop({ required: true, index: true }) storeId: string;
  @Prop({ required: true, index: true }) productId: string;
  @Prop({ required: true, trim: true, maxlength: 60 }) askerName: string;
  /** Private: only the seller sees it (to reply by email if they want). */
  @Prop({ type: String, default: '', trim: true, maxlength: 160 }) askerEmail: string;
  @Prop({ required: true, trim: true, maxlength: 500 }) question: string;
  @Prop({ type: String, default: '', trim: true, maxlength: 1500 }) answer: string;
  @Prop({ type: Date, default: null }) answeredAt: Date | null;
  @Prop({ type: String, enum: QUESTION_STATUSES, default: 'pending', index: true }) status: QuestionStatus;
}
export type ProductQuestionDocument = HydratedDocument<ProductQuestion>;
export const ProductQuestionSchema = SchemaFactory.createForClass(ProductQuestion);
ProductQuestionSchema.index({ storeId: 1, productId: 1, status: 1, createdAt: -1 });
