/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesTargetDocument = SalesTarget & Document;

/** A rep's goals for one month. A blank (null) goal is simply not tracked. */
@Schema({ timestamps: true, collection: 'sales_targets' })
export class SalesTarget {
  @Prop({ type: String, required: true }) adminId: string;
  /** 'YYYY-MM' (Pakistan time). */
  @Prop({ type: String, required: true }) month: string;
  @Prop({ type: Number, default: null }) wonDeals: number | null;
  @Prop({ type: Number, default: null }) wonValuePKR: number | null;
  /** Calls, WhatsApps, meetings and emails logged. */
  @Prop({ type: Number, default: null }) activities: number | null;
  @Prop({ type: String, default: null }) updatedByAdminId: string | null;
}

export const SalesTargetSchema = SchemaFactory.createForClass(SalesTarget);
SalesTargetSchema.index({ adminId: 1, month: 1 }, { unique: true });
