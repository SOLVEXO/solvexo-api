/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

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
}

export const SalesPartnerSchema = SchemaFactory.createForClass(SalesPartner);
