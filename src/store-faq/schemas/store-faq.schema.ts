import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StoreFaqDocument = HydratedDocument<StoreFaq>;

// A seller-authored FAQ scoped to exactly one store — distinct from the
// platform-wide `Faq` (src/faqs), which is admin-only and answers questions
// about Solvexo itself, not any individual store. Buyers see these on that
// store's storefront (GET /api/public/store-faqs/:storeId), sellers manage
// their own via /api/store-faq/:storeId.
@Schema({ timestamps: true })
export class StoreFaq {
  _id: string;

  @Prop({ required: true, index: true })
  storeId: string;

  @Prop({ required: true, trim: true })
  question: string;

  @Prop({ required: true })
  answer: string;

  @Prop({ default: 0, min: 0 })
  order: number;

  @Prop({ default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const StoreFaqSchema = SchemaFactory.createForClass(StoreFaq);

StoreFaqSchema.index({ storeId: 1, order: 1 });
StoreFaqSchema.index({ storeId: 1, isActive: 1 });

StoreFaqSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
