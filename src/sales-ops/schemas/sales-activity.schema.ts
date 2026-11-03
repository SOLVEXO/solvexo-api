/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ACTIVITY_TYPES } from '../sales-ops.constants';

export type SalesActivityDocument = SalesActivity & Document;

/** One entry on a lead's timeline: a note, a logged call / WhatsApp / meeting, an email sent, or a system event. */
@Schema({ timestamps: true, collection: 'sales_activities' })
export class SalesActivity {
  @Prop({ type: String, required: true, index: true }) leadId: string;
  @Prop({ type: String, enum: ACTIVITY_TYPES, required: true }) type: string;
  @Prop({ type: String, default: null }) subject: string | null;
  @Prop({ type: String, default: '' }) body: string;
  /** Call / meeting outcome, e.g. "interested", "no answer". */
  @Prop({ type: String, default: null }) outcome: string | null;
  /** Null for system events. */
  @Prop({ type: String, default: null }) adminId: string | null;
  @Prop({ type: Object, default: null }) meta: Record<string, unknown> | null;
}

export const SalesActivitySchema = SchemaFactory.createForClass(SalesActivity);
SalesActivitySchema.index({ leadId: 1, createdAt: -1 });
