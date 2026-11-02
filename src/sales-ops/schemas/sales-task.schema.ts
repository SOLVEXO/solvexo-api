/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SalesTaskDocument = SalesTask & Document;

/** A follow-up to do for a lead (call back, send pricing, book a demo), with a due date and an assignee. */
@Schema({ timestamps: true, collection: 'sales_tasks' })
export class SalesTask {
  @Prop({ type: String, required: true, index: true }) leadId: string;
  @Prop({ type: String, required: true, trim: true }) title: string;
  @Prop({ type: Date, required: true, index: true }) dueAt: Date;
  @Prop({ type: String, default: null, index: true }) assigneeAdminId:
    | string
    | null;
  @Prop({ type: Date, default: null }) doneAt: Date | null;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;
}

export const SalesTaskSchema = SchemaFactory.createForClass(SalesTask);
