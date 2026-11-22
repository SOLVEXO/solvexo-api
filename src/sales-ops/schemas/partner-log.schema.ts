/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

/**
 * What Solvexo records about a partner over time (programme B13/B14): monthly pipeline reviews, quarterly business
 * reviews, complaints, and (phase 4) written warnings, improvement plans and suspensions.
 */
export const PARTNER_LOG_TYPES = ['monthly_review', 'qbr', 'complaint', 'note', 'warning', 'improvement_plan', 'suspension', 'reinstated'] as const;
export type PartnerLogType = (typeof PARTNER_LOG_TYPES)[number];

export type PartnerLogDocument = PartnerLog & Document;

@Schema({ timestamps: true, collection: 'partner_logs' })
export class PartnerLog {
  @Prop({ type: String, required: true, index: true }) partnerId: string;
  @Prop({ type: String, enum: PARTNER_LOG_TYPES, required: true }) type: string;
  @Prop({ type: Date, required: true }) at: Date;
  @Prop({ type: String, default: null }) by: string | null;
  @Prop({ type: String, required: true, trim: true }) summary: string;
  @Prop({ type: String, default: null }) details: string | null;
  /** QBR: the plan agreed for next quarter. Improvement plan: what must change. */
  @Prop({ type: String, default: null }) plan: string | null;
  /** Complaint: who complained (a seller or store), and when it was resolved. */
  @Prop({ type: String, default: null }) about: string | null;
  @Prop({ type: Date, default: null }) resolvedAt: Date | null;
  /** Improvement plan / warning: the date by which it must be fixed. */
  @Prop({ type: Date, default: null }) dueAt: Date | null;
  /** Review snapshot: the scorecard numbers at the time, so a review keeps what was discussed. */
  @Prop({ type: Object, default: null }) snapshot: Record<string, unknown> | null;
  /** Shown to the partner on their page (reviews, warnings) or kept internal (notes). */
  @Prop({ type: Boolean, default: true }) visibleToPartner: boolean;
}

export const PartnerLogSchema = SchemaFactory.createForClass(PartnerLog);
PartnerLogSchema.index({ partnerId: 1, at: -1 });
