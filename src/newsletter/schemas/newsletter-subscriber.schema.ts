import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NewsletterSubscriberDocument =
  HydratedDocument<NewsletterSubscriber>;

@Schema({ timestamps: true })
export class NewsletterSubscriber {
  _id: string;

  @Prop({ required: true, trim: true, lowercase: true, unique: true })
  email: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ required: true })
  unsubscribeToken: string;

  @Prop({ default: 'footer' })
  source: string;

  @Prop()
  unsubscribedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const NewsletterSubscriberSchema =
  SchemaFactory.createForClass(NewsletterSubscriber);
NewsletterSubscriberSchema.index({ isActive: 1 });

NewsletterSubscriberSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  delete obj.unsubscribeToken;
  return obj;
};
