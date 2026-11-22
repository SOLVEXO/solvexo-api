/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { ENTITY_TYPES, PARTNER_DOC_TYPES, PARTNER_MODELS, PARTNER_STAGES, PARTNER_TIERS, RESELLER_MODES } from '../partner-programme.util';

export const PARTNER_KINDS = ['rep', 'reseller', 'agent'] as const;
export const PAYOUT_METHODS = [
  'bank',
  'jazzcash',
  'easypaisa',
  'cash',
  'other',
] as const;

export type SalesPartnerDocument = SalesPartner & Document;

/**
 * Someone who earns commission for bringing in paying merchants: a sales rep, a reseller or an outside agent.
 * `code` goes on their referral links (solvexo.store/?partner=CODE). `adminId` links the partner to an admin login
 * so they can see their own earnings (reps already have one; outside partners get a "Partner" role login).
 */
@Schema({ timestamps: true, collection: 'sales_partners' })
export class SalesPartner {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, enum: PARTNER_KINDS, default: 'agent' }) kind: string;
  /** Upper-case letters and digits; unique. */
  @Prop({
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  })
  code: string;
  @Prop({ type: String, default: null, index: true }) adminId: string | null;
  @Prop({ type: String, default: null, lowercase: true, trim: true }) email:
    | string
    | null;
  @Prop({ type: String, default: null, trim: true }) phone: string | null;
  @Prop({ type: String, default: null, trim: true }) city: string | null;
  @Prop({ type: String, default: null }) planId: string | null;
  @Prop({ type: String, enum: PAYOUT_METHODS, default: 'bank' })
  payoutMethod: string;
  /** Account title, number / IBAN, bank: free text, shown only to managers and the partner. */
  @Prop({ type: String, default: null }) payoutDetails: string | null;
  @Prop({ type: String, enum: ['active', 'paused'], default: 'active' })
  status: string;
  @Prop({ type: String, default: null }) notes: string | null;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;

  // ── Channel Partner Programme (onboarding & vetting) ──────────────────────
  /** null = created before the programme (counts as live). See partner-programme.util.ts PARTNER_STAGES. */
  @Prop({ type: String, enum: [...PARTNER_STAGES, null], default: null, index: true }) stage: string | null;
  @Prop({ type: String, enum: [...ENTITY_TYPES, null], default: null }) entityType: string | null;
  /** B2 model (named partnerModel: `model` is taken by Mongoose documents). */
  @Prop({ type: String, enum: [...PARTNER_MODELS, null], default: null }) partnerModel: string | null;
  @Prop({ type: String, enum: [...RESELLER_MODES, null], default: null }) resellerMode: string | null;
  @Prop({ type: String, enum: [...PARTNER_TIERS, null], default: null }) tier: string | null;
  /** e.g. "Lahore District" (as defined in the schedule). */
  @Prop({ type: String, default: null, trim: true }) territory: string | null;
  @Prop({ type: Boolean, default: false }) exclusive: boolean;
  @Prop({ type: Date, default: null }) exclusiveFrom: Date | null;
  @Prop({ type: Date, default: null }) exclusiveUntil: Date | null;
  /** B6: existing customers / national chains Solvexo handles directly (store names or emails), excluded from the partner. */
  @Prop({ type: [String], default: [] }) houseAccounts: string[];

  /** What the applicant told us (B12). */
  @Prop({
    type: {
      contactName: String, contactRole: String, legalName: String, registrationNo: String, ntn: String, cnic: String,
      address: String, teamSize: Number, salesContact: String, supportContact: String, website: String,
      claimedPartnerships: String, segments: String, plan90: String, heardFrom: String, message: String,
      references: [{ name: String, company: String, phone: String, email: String, _id: false }],
      consentAt: Date, ip: String,
    },
    default: null,
    _id: false,
  })
  application: Record<string, any> | null;
  @Prop({ type: Date, default: null }) appliedAt: Date | null;
  /** First look passed: the applicant got a login to upload documents. */
  @Prop({ type: Date, default: null }) invitedAt: Date | null;
  @Prop({ type: Date, default: null }) approvedAt: Date | null;
  @Prop({ type: String, default: null }) approvedBy: string | null;
  @Prop({ type: Date, default: null }) rejectedAt: Date | null;
  @Prop({ type: String, default: null }) rejectReason: string | null;

  @Prop({
    type: [{
      type: { type: String, enum: PARTNER_DOC_TYPES }, publicId: String, resourceType: String, fileName: String, mimeType: String,
      fileSize: Number, uploadedAt: Date, uploadedBy: String, uploadedByRole: String,
      status: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
      reviewNote: String, reviewedAt: Date, reviewedBy: String,
    }],
    default: [],
  })
  documents: any[];

  @Prop({
    type: { version: String, entity: String, signedAt: Date, startsAt: Date, pilotEndsAt: Date, termEndsAt: Date, noticeBy: Date, note: String },
    default: null,
    _id: false,
  })
  agreement: Record<string, any> | null;

  /** Salespeople; certified = ran a live demo for Solvexo (B12 week 3). */
  @Prop({ type: [{ name: String, phone: String, email: String, certifiedAt: Date, certifiedBy: String }], default: [] })
  staff: any[];
  /** Demo stores issued to the partner (not for resale): store ids. */
  @Prop({ type: [String], default: [] }) demoStoreIds: string[];
  /** Manager ticks on the onboarding checklist: key → { at, by }. */
  @Prop({ type: Object, default: {} }) checklist: Record<string, { at: Date; by: string | null } | null>;
}

export const SalesPartnerSchema = SchemaFactory.createForClass(SalesPartner);
