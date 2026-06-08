import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type RatingDocument = Rating & Document;

@Schema({ timestamps: true })
export class Rating {

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  productId: string;

  @Prop({ required: false })
  productVariantId: string ;

  @Prop({ required: true, min: 1, max: 5 })
  rating: number;

}

export const RatingSchema = SchemaFactory.createForClass(Rating);

// indexes
RatingSchema.index({ productId: 1 });
RatingSchema.index({ userId: 1 });