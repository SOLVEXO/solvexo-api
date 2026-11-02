/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const REFERRAL_SOURCES = [
  'code',
  'demo_form',
  'lead_owner',
  'manual',
] as const;

export type SalesPartnerReferralDocument = SalesPartnerReferral & Document;

/** Which partner gets credit for a merchant. One per merchant; only a manager can change it. */
@Schema({ timestamps: true, collection: 'sales_partner_referrals' })
export class SalesPartnerReferral {
  @Prop({ type: String, required: true, unique: true }) sellerId: string;
  @Prop({ type: String, required: true, index: true }) partnerId: string;
  /** code = signed up with the partner's link; demo_form = booked a demo with it; lead_owner = the rep who owned
   *  their lead; manual = a manager set it. */
  @Prop({ type: String, enum: REFERRAL_SOURCES, required: true })
  source: string;
  /** Payments from this date earn commission (the merchant's sign-up, or the date a manager chose). */
  @Prop({ type: Date, required: true }) effectiveFrom: Date;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;
}

export const SalesPartnerReferralSchema =
  SchemaFactory.createForClass(SalesPartnerReferral);
