/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmailDailyStatDocument = EmailDailyStat & Document;

/** One row per UTC day: how many emails the platform's SMTP accepted / rejected (admin "Email health"). */
@Schema({ timestamps: true })
export class EmailDailyStat {
  /** YYYY-MM-DD (UTC) */
  @Prop({ required: true, unique: true })
  date: string;

  @Prop({ default: 0 })
  sent: number;

  @Prop({ default: 0 })
  failed: number;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ type: Date, default: null })
  lastErrorAt: Date | null;
}

export const EmailDailyStatSchema = SchemaFactory.createForClass(EmailDailyStat);
// Old days are dropped by Mongo itself (90 days).
EmailDailyStatSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
