import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OnboardingSlideDocument = HydratedDocument<OnboardingSlide>;

@Schema({ timestamps: true })
export class OnboardingSlide {
  _id: string;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  subtitle: string;

  @Prop({ required: true })
  imageUrl: string;

  @Prop({ default: '' })
  publicId: string;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: true })
  isActive: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const OnboardingSlideSchema = SchemaFactory.createForClass(OnboardingSlide);

OnboardingSlideSchema.index({ isActive: 1, order: 1 });

OnboardingSlideSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};
