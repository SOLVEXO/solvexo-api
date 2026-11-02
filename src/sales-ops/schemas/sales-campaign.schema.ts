/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export const CAMPAIGN_CHANNELS = [
  'facebook',
  'instagram',
  'google',
  'tiktok',
  'youtube',
  'whatsapp',
  'email',
  'sms',
  'influencer',
  'event',
  'other',
] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export type SalesCampaignDocument = SalesCampaign & Document;

/** One spend entry: money that went into the campaign on a date (ad top-up, influencer fee, event stall...). */
export class CampaignSpend {
  _id?: string;
  date: Date;
  amountPKR: number;
  note: string | null;
  adminId: string | null;
}

/**
 * A marketing campaign. `code` is the utm_campaign value on its links: every lead (SalesLead.utm.campaign) and
 * merchant sign-up (Seller.acquisitionCampaign) carrying it counts toward the campaign.
 */
@Schema({ timestamps: true, collection: 'sales_campaigns' })
export class SalesCampaign {
  @Prop({ type: String, required: true, trim: true }) name: string;
  /** Lower-case, letters/digits/dashes; unique. */
  @Prop({
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  })
  code: string;
  @Prop({ type: String, enum: CAMPAIGN_CHANNELS, default: 'other' })
  channel: string;
  /** utm_source / utm_medium written on the campaign's links. */
  @Prop({ type: String, default: null, trim: true }) utmSource: string | null;
  @Prop({ type: String, default: null, trim: true }) utmMedium: string | null;
  /** Page on solvexo.store the links open (e.g. /book-demo, /pricing, /). */
  @Prop({ type: String, default: '/book-demo', trim: true })
  landingPath: string;
  @Prop({ type: Date, default: null }) startDate: Date | null;
  @Prop({ type: Date, default: null }) endDate: Date | null;
  @Prop({ type: Number, default: null }) budgetPKR: number | null;
  @Prop({
    type: [
      {
        date: { type: Date, required: true },
        amountPKR: { type: Number, required: true },
        note: { type: String, default: null },
        adminId: { type: String, default: null },
      },
    ],
    default: [],
  })
  spend: CampaignSpend[];
  @Prop({ type: String, default: null }) notes: string | null;
  @Prop({ type: Boolean, default: false, index: true }) isArchived: boolean;
  @Prop({ type: String, default: null }) createdByAdminId: string | null;
}

export const SalesCampaignSchema = SchemaFactory.createForClass(SalesCampaign);
