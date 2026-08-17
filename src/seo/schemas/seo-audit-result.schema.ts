/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SeoAuditResultDocument = SeoAuditResult & Document;

@Schema({ _id: false })
export class SeoAuditIssue {
  @Prop({ type: String, enum: ['info', 'warning', 'error'], required: true })
  severity: string;

  @Prop({ type: String, required: true })
  code: string;

  @Prop({ type: String, required: true })
  message: string;

  @Prop({ type: String, enum: ['product', 'category', 'store'], default: null })
  entityType: string | null;

  @Prop({ type: String, default: null })
  entityId: string | null;
}
export const SeoAuditIssueSchema = SchemaFactory.createForClass(SeoAuditIssue);

@Schema({ timestamps: true })
export class SeoAuditResult {
  @Prop({ type: String, required: true })
  storeId: string;

  @Prop({ type: Number, required: true })
  score: number;

  @Prop({ type: [SeoAuditIssueSchema], default: [] })
  issues: SeoAuditIssue[];

  @Prop({ type: Number, default: 0 })
  checklistCompletionPercent: number;

  @Prop({ type: Date, required: true })
  runAt: Date;
}

export const SeoAuditResultSchema = SchemaFactory.createForClass(SeoAuditResult);
SeoAuditResultSchema.index({ storeId: 1, runAt: -1 });
