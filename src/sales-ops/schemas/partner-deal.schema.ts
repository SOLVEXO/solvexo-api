/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { DEAL_PROGRESS, DEAL_STATUSES } from '../partner-deals.util';

export type PartnerDealDocument = PartnerDeal & Document;

/** B7: a prospect a partner registered (with the seller's permission), and Solvexo's decision on it. */
@Schema({ timestamps: true, collection: 'partner_deal_registrations' })
export class PartnerDeal {
  @Prop({ type: String, required: true, index: true }) partnerId: string;
  @Prop({ type: String, required: true, trim: true }) businessName: string;
  @Prop({ type: String, default: null, trim: true }) contactName: string | null;
  @Prop({ type: String, default: null, trim: true }) phone: string | null;
  @Prop({ type: String, default: null, lowercase: true, trim: true }) email: string | null;
  @Prop({ type: String, default: null, trim: true }) city: string | null;
  @Prop({ type: String, default: null, trim: true }) link: string | null;
  @Prop({ type: String, default: null }) notes: string | null;
  /** The partner confirmed the seller agreed to be registered (B7.1). */
  @Prop({ type: Date, required: true }) consentAt: Date;
  @Prop({ type: String, default: null }) consentNote: string | null;

  @Prop({ type: String, default: null, index: true }) phoneKey: string | null;
  @Prop({ type: String, default: null, index: true }) emailKey: string | null;
  @Prop({ type: String, default: null, index: true }) nameKey: string | null;

  @Prop({ type: String, enum: DEAL_STATUSES, default: 'pending', index: true }) status: string;
  @Prop({ type: Date, required: true }) submittedAt: Date;
  @Prop({ type: Date, required: true }) decisionDueAt: Date;
  @Prop({ type: Date, default: null }) decidedAt: Date | null;
  @Prop({ type: String, default: null }) decidedBy: string | null;
  /** 'auto' when B7 decided it on its own (existing customer, house account, protected registration). */
  @Prop({ type: String, default: null }) decidedHow: string | null;
  @Prop({ type: String, default: null }) rejectReason: string | null;
  @Prop({ type: Date, default: null, index: true }) protectedUntil: Date | null;
  @Prop({ type: [{ at: Date, by: String, progress: { type: String, enum: DEAL_PROGRESS }, note: String, until: Date, _id: false }], default: [] })
  extensions: { at: Date; by: string; progress: string; note: string | null; until: Date }[];
  /** Extension asked for by the partner, waiting for a manager. */
  @Prop({ type: { at: Date, progress: String, note: String }, default: null, _id: false })
  extensionRequest: { at: Date; progress: string; note: string | null } | null;
  @Prop({ type: [{ kind: String, detail: String, refId: String, _id: false }], default: [] })
  conflicts: { kind: string; detail: string; refId?: string }[];
  @Prop({ type: String, default: null, index: true }) sellerId: string | null;
  @Prop({ type: Date, default: null }) wonAt: Date | null;
  @Prop({ type: Date, default: null }) overdueNotifiedAt: Date | null;
}

export const PartnerDealSchema = SchemaFactory.createForClass(PartnerDeal);
PartnerDealSchema.index({ status: 1, protectedUntil: 1 });
