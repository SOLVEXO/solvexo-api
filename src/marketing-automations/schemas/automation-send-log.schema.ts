/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AutomationSendLogDocument = HydratedDocument<AutomationSendLog>;

export const AUTOMATION_TYPES = ['welcome', 'back_in_stock', 'price_drop', 'win_back'] as const;
export type AutomationType = (typeof AUTOMATION_TYPES)[number];

/** One row per automated email sent — the seller's per-automation stats, and
 *  the dedupe guard: `refKey` identifies what the email was about (a variant
 *  + price for price drops, a customer's last order date for win-back), and
 *  the unique index makes a double cron tick unable to email twice. */
@Schema({ timestamps: true })
export class AutomationSendLog {
  _id: string;

  @Prop({ required: true }) storeId: string;
  @Prop({ type: String, enum: AUTOMATION_TYPES, required: true }) type: AutomationType;
  @Prop({ required: true, lowercase: true, trim: true }) email: string;
  @Prop({ required: true }) refKey: string;
  @Prop({ default: true }) delivered: boolean;

  createdAt?: Date;
}

export const AutomationSendLogSchema = SchemaFactory.createForClass(AutomationSendLog);
AutomationSendLogSchema.index({ storeId: 1, type: 1, email: 1, refKey: 1 }, { unique: true });
AutomationSendLogSchema.index({ storeId: 1, type: 1, createdAt: -1 });
