import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RatingDocument = Rating & Document;

@Schema({ _id: false })
class ReviewComment {
  @Prop({ required: true })
  text!: string;

  @Prop({ default: () => new Date() })
  createdAt!: Date;
}
const ReviewCommentSchema = SchemaFactory.createForClass(ReviewComment);

@Schema({ timestamps: true })
export class Rating {
  @Prop({ required: true })
  userId!: string;

  @Prop({ required: true })
  productId!: string;

  @Prop({ type: String, default: null })
  productVariantId!: string | null;

  @Prop({ type: String, default: null })
  orderId!: string | null;

  @Prop({ type: Number, min: 1, max: 5, default: null })
  rating!: number | null;

  @Prop({ type: [ReviewCommentSchema], default: [] })
  comments!: ReviewComment[];

  @Prop({ type: [String], default: [] })
  media!: string[];

  @Prop({ default: false })
  isAnonymous!: boolean;

  @Prop({ default: false })
  isDelete!: boolean;
}

export const RatingSchema = SchemaFactory.createForClass(Rating);

RatingSchema.index({ productId: 1 });
RatingSchema.index({ userId: 1 });
RatingSchema.index({ userId: 1, productId: 1 });
