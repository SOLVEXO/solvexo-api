/* eslint-disable prettier/prettier */
import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { QUEUE_NAMES, EMAIL_CAMPAIGN_SEND_JOB } from '@/queues/queue.constants';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { CreateEmailCampaignDto } from './dto/create-email-campaign.dto';
import { UpdateEmailCampaignDto } from './dto/update-email-campaign.dto';
import { EmailCampaignAudience } from './schemas/email-campaign.schema';

const PLATFORM_ORIGIN = 'https://solvexo.store';

/** Seller-authored bulk email blasts (the Shopify Email equivalent) — real
 *  audience resolution off actual User/Order/Checkout data, real queued
 *  sends (one BullMQ job per recipient, same durable-retry pattern as
 *  SubscriptionEmailProcessor), and real per-recipient open/click tracking
 *  via EmailCampaignSend — not a fire-and-forget loop or a stub counter. */
@Injectable()
export class EmailCampaignsService {
  private readonly logger = new Logger(EmailCampaignsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly entitlementsService: EntitlementsService,
    @InjectQueue(QUEUE_NAMES.EMAIL_CAMPAIGNS) private readonly queue: Queue,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async getOwnedCampaign(storeId: string, sellerId: string, campaignId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const campaign = await this.r.emailCampaignModel.findOne({ _id: campaignId, storeId, isDelete: false });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(sellerId: string, storeId: string, dto: CreateEmailCampaignDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const campaign = await this.r.emailCampaignModel.create({ storeId, ...dto, status: 'draft' });
    return { success: true, message: 'Campaign created', data: campaign };
  }

  async list(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
    const filter: any = { storeId, isDelete: false };
    if (query.status) filter.status = query.status;

    const [campaigns, total] = await Promise.all([
      this.r.emailCampaignModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.emailCampaignModel.countDocuments(filter),
    ]);
    return { success: true, message: 'Email campaigns', data: { campaigns, total, page, limit } };
  }

  async getOne(sellerId: string, storeId: string, campaignId: string) {
    const campaign = await this.getOwnedCampaign(storeId, sellerId, campaignId);
    return { success: true, message: 'Campaign', data: campaign };
  }

  async update(sellerId: string, storeId: string, campaignId: string, dto: UpdateEmailCampaignDto) {
    const campaign = await this.getOwnedCampaign(storeId, sellerId, campaignId);
    if (campaign.status !== 'draft') throw new BadRequestException('Only a draft campaign can be edited');
    Object.assign(campaign, dto);
    await campaign.save();
    return { success: true, message: 'Campaign updated', data: campaign };
  }

  async remove(sellerId: string, storeId: string, campaignId: string) {
    const campaign = await this.getOwnedCampaign(storeId, sellerId, campaignId);
    if (!['draft', 'scheduled'].includes(campaign.status)) throw new BadRequestException('A sent/sending campaign cannot be deleted');
    campaign.isDelete = true;
    await campaign.save();
    return { success: true, message: 'Campaign deleted' };
  }

  // ── Audience resolution ──────────────────────────────────────────────────

  /** Resolved fresh every time a campaign actually fires — see the audience
   *  doc comment on the schema for what each value means on a marketplace
   *  (a store's own customer list, not the whole platform). Deduped by
   *  email since the same person can be both a native-storefront account
   *  and a buyer, or (rarely) hold more than one account with the same
   *  email across legacy/per-store rows. */
  private async resolveAudience(storeId: string, audience: EmailCampaignAudience) {
    const { userModel, orderModel, checkoutModel } = this.r;

    let buyerIds: string[] = [];
    if (audience === 'buyers' || audience === 'all') {
      buyerIds = await orderModel.distinct('userId', { 'sellerOrders.storeId': storeId });
    }

    let abandonedIds: string[] = [];
    if (audience === 'abandoned') {
      abandonedIds = await checkoutModel.distinct('userId', {
        'items.storeId': storeId,
        abandonedEmailSentAt: { $ne: null },
        recoveredAt: null,
        isDelete: false,
      });
    }

    let nativeStoreUsers: any[] = [];
    if (audience === 'all') {
      nativeStoreUsers = await userModel.find({ storeId, isDelete: { $ne: true } }).select('name email').lean();
    }

    const idsToFetch = [...new Set([...buyerIds, ...abandonedIds])];
    const idBasedUsers = idsToFetch.length
      ? await userModel.find({ _id: { $in: idsToFetch }, isDelete: { $ne: true } }).select('name email').lean()
      : [];

    const byEmail = new Map<string, { userId: string; email: string; name: string }>();
    for (const u of [...nativeStoreUsers, ...idBasedUsers] as any[]) {
      const email = (u.email || '').toLowerCase().trim();
      if (!email || byEmail.has(email)) continue;
      byEmail.set(email, { userId: u._id.toString(), email, name: u.name || 'there' });
    }
    return [...byEmail.values()];
  }

  /** Lets the frontend show "~N recipients" before the seller actually
   *  commits to sending — same resolution logic, no side effects. */
  async previewAudience(sellerId: string, storeId: string, audience: EmailCampaignAudience) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const recipients = await this.resolveAudience(storeId, audience);
    return { success: true, data: { recipientCount: recipients.length } };
  }

  private renderTemplate(template: string, vars: Record<string, string>) {
    return Object.entries(vars).reduce((text, [key, val]) => text.split(`{{${key}}}`).join(val), template);
  }

  // ── Send / schedule ───────────────────────────────────────────────────────

  /** Shared by send-now and the scheduler's cron firing a due 'scheduled'
   *  campaign — creates one EmailCampaignSend row + one queued job per
   *  resolved recipient, then flips the campaign to 'sending' (the
   *  processor moves it to 'sent' once every job has resolved). */
  private async executeSend(campaign: any) {
    // The one real point both sendNow() and the scheduled-campaign cron
    // funnel through — checked here, not at create/schedule time, so a plan
    // downgrade between scheduling and the campaign's actual send date still
    // blocks it (processScheduledCampaigns already catches and marks a
    // thrown campaign 'failed', so this needs no extra error handling here).
    await this.entitlementsService.assertFeatureAllowed(campaign.storeId, 'emailCampaignsAllowed', 'Email Campaigns');
    const store = await this.r.storeModel.findById(campaign.storeId).select('name').lean();
    const recipients = await this.resolveAudience(campaign.storeId, campaign.audience);

    if (recipients.length === 0) {
      campaign.status = 'failed';
      await campaign.save();
      return { recipientCount: 0 };
    }

    const sends = recipients.map((rcpt) => ({
      campaignId: campaign._id.toString(),
      storeId: campaign.storeId,
      email: rcpt.email,
    }));
    const createdSends = await this.r.emailCampaignSendModel.insertMany(sends);

    campaign.status = 'sending';
    campaign.sentAt = new Date();
    campaign.recipientCount = recipients.length;
    await campaign.save();

    for (let i = 0; i < createdSends.length; i++) {
      const send = createdSends[i] as any;
      const rcpt = recipients[i];
      await this.queue.add(EMAIL_CAMPAIGN_SEND_JOB, {
        sendId: send._id.toString(),
        campaignId: campaign._id.toString(),
        email: rcpt.email,
        customerName: rcpt.name,
        storeName: (store as any)?.name ?? 'the store',
        subject: campaign.subject,
        message: campaign.message,
      });
    }

    this.activityLogService.log({
      storeId: campaign.storeId, category: 'marketing', action: 'email_campaign_sent',
      description: `Email campaign "${campaign.name}" queued for ${recipients.length} recipient(s)`,
      actorRole: 'seller', targetId: campaign._id.toString(), targetType: 'email_campaign',
    });

    return { recipientCount: recipients.length };
  }

  async sendNow(sellerId: string, storeId: string, campaignId: string) {
    const campaign = await this.getOwnedCampaign(storeId, sellerId, campaignId);
    if (!['draft', 'scheduled'].includes(campaign.status)) throw new BadRequestException('Campaign already sent/sending');
    campaign.scheduledAt = null;
    const result = await this.executeSend(campaign);
    return { success: true, message: `Campaign sending to ${result.recipientCount} recipient(s)`, data: campaign };
  }

  async schedule(sellerId: string, storeId: string, campaignId: string, scheduledAt: string) {
    const campaign = await this.getOwnedCampaign(storeId, sellerId, campaignId);
    if (campaign.status !== 'draft') throw new BadRequestException('Only a draft campaign can be scheduled');
    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) throw new BadRequestException('scheduledAt must be a valid future date');
    campaign.status = 'scheduled';
    campaign.scheduledAt = when;
    await campaign.save();
    return { success: true, message: 'Campaign scheduled', data: campaign };
  }

  /** Called from SchedulerService's cron tick. */
  async processScheduledCampaigns(): Promise<{ processed: number }> {
    const due = await this.r.emailCampaignModel.find({ status: 'scheduled', scheduledAt: { $lte: new Date() }, isDelete: false }).limit(50);
    for (const campaign of due) {
      try {
        await this.executeSend(campaign);
      } catch (e: any) {
        this.logger.error(`processScheduledCampaigns: failed for campaign ${campaign._id}: ${e?.message}`);
        campaign.status = 'failed';
        await campaign.save();
      }
    }
    return { processed: due.length };
  }

  // ── Processor callbacks (see EmailCampaignsProcessor) ────────────────────

  async markSendResult(sendId: string, campaignId: string, success: boolean, error?: string) {
    await this.r.emailCampaignSendModel.updateOne(
      { _id: sendId },
      success ? { $set: { sentAt: new Date() } } : { $set: { error: error ?? 'send failed' } },
    );
    await this.r.emailCampaignModel.updateOne(
      { _id: campaignId },
      success ? { $inc: { sentCount: 1 } } : { $inc: { failedCount: 1 } },
    );
    await this.maybeFinalizeCampaign(campaignId);
  }

  /** Once every recipient's job has resolved (sent or failed), the campaign
   *  is done — flip it to 'sent' (or 'failed' if not a single one went
   *  through) so the seller isn't left staring at "sending" forever. */
  private async maybeFinalizeCampaign(campaignId: string) {
    const campaign = await this.r.emailCampaignModel.findOne({ _id: campaignId, status: 'sending' });
    if (!campaign) return;
    if (campaign.sentCount + campaign.failedCount < campaign.recipientCount) return;
    campaign.status = campaign.sentCount > 0 ? 'sent' : 'failed';
    await campaign.save();
  }

  // ── Public tracking endpoints ─────────────────────────────────────────────

  private static readonly TRANSPARENT_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
    'base64',
  );

  /** 1x1 tracking pixel embedded in the sent email — idempotent (only the
   *  first open per recipient increments the campaign counter). `sendId` is
   *  the EmailCampaignSend doc's own `_id`, not a guessable value. */
  async trackOpen(sendId: string): Promise<Buffer> {
    let send: any = null;
    try {
      send = await this.r.emailCampaignSendModel.findOneAndUpdate(
        { _id: sendId, openedAt: null },
        { $set: { openedAt: new Date() } },
      );
    } catch {
      // malformed/unknown id — still return the pixel so the email client sees a normal image
    }
    if (send) await this.r.emailCampaignModel.updateOne({ _id: send.campaignId }, { $inc: { openCount: 1 } });
    return EmailCampaignsService.TRANSPARENT_GIF;
  }

  /** Every link in the email body is rewritten to point here first — records
   *  the click once, then redirects on to the store. */
  async trackClick(sendId: string): Promise<string> {
    let send: any = null;
    try {
      send = await this.r.emailCampaignSendModel.findOneAndUpdate(
        { _id: sendId, clickedAt: null },
        { $set: { clickedAt: new Date() } },
      );
    } catch {
      // malformed/unknown id — fall through to the platform default below
    }
    if (send) await this.r.emailCampaignModel.updateOne({ _id: send.campaignId }, { $inc: { clickCount: 1 } });
    const storeId = send?.storeId;
    const store = storeId ? await this.r.storeModel.findById(storeId).select('slug').lean() : null;
    const slug = (store as any)?.slug;
    return slug ? `${PLATFORM_ORIGIN}/store/${slug}` : PLATFORM_ORIGIN;
  }
}
