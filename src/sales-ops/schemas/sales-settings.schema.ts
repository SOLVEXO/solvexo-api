/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesSettingsDocument = SalesSettings & Document;

/** Sales Ops settings: one document, key 'default'. */
@Schema({ timestamps: true, collection: 'sales_settings' })
export class SalesSettings {
  @Prop({ type: String, required: true, unique: true, default: 'default' })
  key: string;
  /** Give new leads that arrive on their own (forms, messages, stalled sign-ups) to these reps in turn. */
  @Prop({ type: Boolean, default: false }) autoAssign: boolean;
  @Prop({ type: [String], default: [] }) assigneeIds: string[];
  /** Round-robin position; only ever incremented. */
  @Prop({ type: Number, default: 0 }) cursor: number;
}

export const SalesSettingsSchema = SchemaFactory.createForClass(SalesSettings);
