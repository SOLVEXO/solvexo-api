/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FormStatDocument = HydratedDocument<FormStat>;

/** Anonymous daily counters of a form: how many times it was seen and how many visitors started filling it. */
@Schema({ timestamps: false })
export class FormStat {
  _id: string;
  @Prop({ required: true }) storeId: string;
  @Prop({ required: true }) sectionId: string;
  /** UTC day, YYYY-MM-DD. */
  @Prop({ required: true }) day: string;
  @Prop({ default: 0 }) views: number;
  @Prop({ default: 0 }) starts: number;
  /** Counters are kept for a year. */
  @Prop({ type: Date, default: () => new Date(), expires: 366 * 86400 }) createdAt: Date;
}

export const FormStatSchema = SchemaFactory.createForClass(FormStat);
FormStatSchema.index({ storeId: 1, sectionId: 1, day: 1 }, { unique: true });
