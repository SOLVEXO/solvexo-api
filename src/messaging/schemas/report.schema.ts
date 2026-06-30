/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReportDocument = Report & Document;

@Schema({ timestamps: true })
export class Report {
  @Prop({ type: String, required: true }) reporterId: string;
  @Prop({ type: String, required: true }) reporterRole: string;

  @Prop({ type: String, enum: ['user', 'message', 'conversation'], required: true }) targetType: string;
  @Prop({ type: String, required: true }) targetId: string;

  @Prop({ type: String, required: true }) reason: string;
  @Prop({ type: String, default: null }) details: string | null;

  @Prop({ type: String, enum: ['pending', 'reviewed', 'resolved'], default: 'pending' }) status: string;
  @Prop({ type: String, default: null }) adminNotes: string | null;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

ReportSchema.index({ reporterId: 1 });
ReportSchema.index({ targetId: 1 });
ReportSchema.index({ status: 1, createdAt: -1 });
