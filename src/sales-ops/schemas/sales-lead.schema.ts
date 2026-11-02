/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import {
  LEAD_SOURCES,
  LEAD_STAGES,
  LOST_REASONS,
} from '../sales-ops.constants';

export type SalesLeadDocument = SalesLead & Document;

/** A prospective merchant in the Solvexo sales pipeline, from first contact until they pay (or are lost). */
@Schema({ timestamps: true, collection: 'sales_leads' })
export class SalesLead {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, default: null, trim: true }) businessName:
    | string
    | null;
  /** Lower-cased; used to link the lead to the merchant account when they sign up. */
  @Prop({ type: String, default: null, lowercase: true, trim: true }) email:
    | string
    | null;
  @Prop({ type: String, default: null, trim: true }) phone: string | null;
  /** Digits only, last 10 (so +92 300 0000000 and 0300-0000000 match). */
  @Prop({ type: String, default: null, index: true }) phoneKey: string | null;
  @Prop({ type: String, default: null, trim: true }) city: string | null;
  @Prop({ type: String, default: null, trim: true }) country: string | null;
  @Prop({ type: String, default: null, trim: true }) businessType:
    | string
    | null;
  @Prop({ type: String, enum: LEAD_SOURCES, default: 'manual' }) source: string;
  @Prop({ type: String, default: null, trim: true }) sourceDetail:
    | string
    | null;
  @Prop({ type: String, enum: LEAD_STAGES, default: 'new', index: true })
  stage: string;
  @Prop({ type: String, enum: [...LOST_REASONS, null], default: null })
  lostReason: string | null;
  @Prop({ type: String, default: null }) lostNote: string | null;
  /** Admin who owns the lead; null = unassigned (only managers see those). */
  @Prop({ type: String, default: null, index: true }) ownerAdminId:
    | string
    | null;
  /** Expected monthly value in PKR (the deal size the rep estimates). */
  @Prop({ type: Number, default: null }) dealValuePKR: number | null;
  @Prop({ type: [String], default: [] }) tags: string[];
  @Prop({ type: Date, default: null, index: true }) nextFollowUpAt: Date | null;
  @Prop({ type: Date, default: null }) lastActivityAt: Date | null;
  @Prop({ type: Date, default: () => new Date() }) stageChangedAt: Date;
  @Prop({ type: Date, default: null }) wonAt: Date | null;
  /** Set once the lead's email or phone matches a merchant account. */
  @Prop({ type: String, default: null, index: true }) sellerId: string | null;
  @Prop({ type: String, default: null }) storeId: string | null;
  @Prop({ type: Date, default: null }) linkedAt: Date | null;
  /** Campaign tags from the link the lead arrived through (utm_source / utm_medium / utm_campaign). */
  @Prop({ type: Object, default: null }) utm: {
    source: string | null;
    medium: string | null;
    campaign: string | null;
  } | null;
  /** A message the AI wrote for a human to send (e.g. a WhatsApp first message when there is no email). */
  @Prop({ type: Object, default: null }) aiDraft: {
    channel: 'whatsapp' | 'email';
    text: string;
    createdAt: Date;
  } | null;
  /** Partner whose referral code came with the lead (Book-a-demo form). */
  @Prop({ type: String, default: null }) partnerId: string | null;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;
  @Prop({ type: Boolean, default: false, index: true }) isDelete: boolean;
}

export const SalesLeadSchema = SchemaFactory.createForClass(SalesLead);
SalesLeadSchema.index({ email: 1 });
SalesLeadSchema.index({ 'utm.campaign': 1 });
SalesLeadSchema.index({ isDelete: 1, stage: 1, updatedAt: -1 });
