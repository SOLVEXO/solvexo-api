/* eslint-disable prettier/prettier */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MarketingCampaignDocument = HydratedDocument<MarketingCampaign>;

export const CAMPAIGN_CHANNELS = ['email', 'social', 'paid', 'search', 'influencer', 'other'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

/**
 * A seller's marketing campaign (Shopify: Growth → Campaigns). It groups every activity of one effort — emails, social
 * posts, ads, influencer links — and is matched to storefront visits by its UTM values, so sessions, orders and sales
 * can be reported per campaign. A visit belongs to the campaign whose `utmCampaign` (and `utmSource`, when set) it carried.
 */
@Schema({ timestamps: true })
export class MarketingCampaign {
  _id: string;

  @Prop({ type: String, required: true, index: true }) storeId: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 120 }) name: string;
  @Prop({ type: String, enum: CAMPAIGN_CHANNELS, default: 'other' }) channel: CampaignChannel;

  // The UTM values that identify this campaign. utmCampaign is the key; source / medium are optional extra matches.
  @Prop({ type: String, required: true, lowercase: true, trim: true, maxlength: 100 }) utmCampaign: string;
  @Prop({ type: String, default: null, lowercase: true, trim: true, maxlength: 100 }) utmSource: string | null;
  @Prop({ type: String, default: null, lowercase: true, trim: true, maxlength: 100 }) utmMedium: string | null;

  @Prop({ type: String, default: '', maxlength: 1000 }) notes: string;
  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' }) status: 'active' | 'archived';
  @Prop({ type: Boolean, default: false }) isDelete: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export const MarketingCampaignSchema = SchemaFactory.createForClass(MarketingCampaign);
// One campaign per UTM campaign name inside a store (a deleted one frees the name).
MarketingCampaignSchema.index({ storeId: 1, utmCampaign: 1 }, { unique: true, partialFilterExpression: { isDelete: false } });
