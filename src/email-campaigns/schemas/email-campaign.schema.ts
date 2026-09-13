import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type EmailCampaignDocument = EmailCampaign & Document;

// Who a campaign goes out to — resolved fresh at send time by
// EmailCampaignsService.resolveAudience, never pre-computed/cached on this
// doc, so a campaign created as a draft always reaches whoever currently
// matches the segment when it's actually sent/scheduled to fire:
//   'all'       — every distinct customer this store has (native storefront
//                  accounts + anyone who has ever bought from it — a
//                  marketplace store's own "everyone" list, not the whole
//                  platform).
//   'buyers'    — only customers with at least one real order containing
//                  this store's items (repeat-purchase / VIP style blast).
//   'abandoned' — customers who abandoned a cart containing this store's
//                  items and never completed it — piggybacks on the
//                  Abandoned Cart module's own Checkout fields instead of
//                  duplicating that tracking.
export type EmailCampaignAudience = 'all' | 'buyers' | 'abandoned';
export type EmailCampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';

/** A seller-authored bulk email blast — the Shopify Email equivalent.
 *  Distinct from admin-marketing's platform-wide sale Campaigns (join/leave
 *  a discount) and from AbandonedCartSettings' single always-on recovery
 *  email: this is a seller composing and firing an arbitrary one-off (or
 *  scheduled) message at a segment of their own store's customers. */
@Schema({ timestamps: true })
export class EmailCampaign {
  @Prop({ required: true })
  storeId: string;

  // Internal label only — never shown to a recipient (that's `subject`).
  @Prop({ required: true, trim: true, maxlength: 200 })
  name: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  subject: string;

  // HTML body. Supports {{customerName}}/{{storeName}} merge tags —
  // rendered per-recipient by EmailCampaignsService.renderTemplate, same
  // convention as AbandonedCartService.
  @Prop({ required: true })
  message: string;

  @Prop({ type: String, enum: ['all', 'buyers', 'abandoned'], required: true })
  audience: EmailCampaignAudience;

  @Prop({
    type: String,
    enum: ['draft', 'scheduled', 'sending', 'sent', 'failed'],
    default: 'draft',
  })
  status: EmailCampaignStatus;

  // Set only when scheduled for a future send — SchedulerService's cron
  // picks up anything due. Null again once it actually starts sending.
  @Prop({ type: Date, default: null })
  scheduledAt: Date | null;

  // Set the moment sending actually starts (send-now or the scheduled cron
  // firing) — not when every recipient's job has finished, since that
  // happens asynchronously off-queue (see EmailCampaignsProcessor).
  @Prop({ type: Date, default: null })
  sentAt: Date | null;

  // Snapshot of the resolved audience size at send time — the send/schedule
  // action fixes this number; it does not grow if more customers match
  // later (the campaign has already gone out to whoever matched then).
  @Prop({ type: Number, default: 0 })
  recipientCount: number;

  // The counters below are incremented by EmailCampaignsProcessor/tracking
  // endpoints as each per-recipient EmailCampaignSend row resolves — never
  // recomputed from scratch, so they stay cheap to read on every list call.
  @Prop({ type: Number, default: 0 })
  sentCount: number;

  @Prop({ type: Number, default: 0 })
  failedCount: number;

  @Prop({ type: Number, default: 0 })
  openCount: number;

  @Prop({ type: Number, default: 0 })
  clickCount: number;

  @Prop({ default: false })
  isDelete: boolean;
}

export const EmailCampaignSchema = SchemaFactory.createForClass(EmailCampaign);
EmailCampaignSchema.index({ storeId: 1, createdAt: -1 });
EmailCampaignSchema.index({ status: 1, scheduledAt: 1 });
