/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NewsletterBroadcastDocument = HydratedDocument<NewsletterBroadcast>;

/** A Solvexo-admin email to the platform's own subscriber list (merchants
 *  and prospects who signed up on Solvexo's public site — storeId null). */
@Schema({ timestamps: true })
export class NewsletterBroadcast {
  _id: string;

  @Prop({ required: true, maxlength: 200 }) subject: string;
  @Prop({ required: true }) message: string;
  @Prop({ type: String, default: null }) createdBy: string | null;

  @Prop({ type: String, enum: ['sending', 'sent', 'failed'], default: 'sending' })
  status: 'sending' | 'sent' | 'failed';

  @Prop({ default: 0 }) recipientCount: number;
  @Prop({ default: 0 }) sentCount: number;
  @Prop({ default: 0 }) failedCount: number;
  @Prop({ type: Date, default: null }) completedAt: Date | null;

  createdAt?: Date;
}

export const NewsletterBroadcastSchema = SchemaFactory.createForClass(NewsletterBroadcast);
NewsletterBroadcastSchema.index({ createdAt: -1 });
