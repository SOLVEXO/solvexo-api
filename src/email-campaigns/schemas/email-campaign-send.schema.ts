import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmailCampaignSendDocument = EmailCampaignSend & Document;

/** One row per recipient per campaign — created up-front when a campaign is
 *  sent/scheduled-fired (so `recipientCount` and the list of who-gets-what
 *  is fixed at that moment), then filled in by EmailCampaignsProcessor as
 *  each recipient's job actually runs. This is what makes open/click
 *  tracking idempotent (same `?guard-on-null` pattern as
 *  Checkout.abandonedClickedAt) and gives per-campaign stats a real
 *  denominator instead of an estimate.
 *
 *  This doc's own Mongo `_id` doubles as the opaque identifier embedded in
 *  the tracking-pixel/click-redirect URLs — never the recipient's raw
 *  email, so a forwarded email can't leak another recipient's tracking
 *  identity, and no separate token field is needed. */
@Schema({ timestamps: true })
export class EmailCampaignSend {
  @Prop({ required: true })
  campaignId: string;

  @Prop({ required: true })
  storeId: string;

  @Prop({ required: true, lowercase: true, trim: true })
  email: string;

  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  @Prop({ type: Date, default: null })
  openedAt: Date | null;

  @Prop({ type: Date, default: null })
  clickedAt: Date | null;

  @Prop({ type: String, default: null })
  error: string | null;
}

export const EmailCampaignSendSchema = SchemaFactory.createForClass(EmailCampaignSend);
EmailCampaignSendSchema.index({ campaignId: 1 });
