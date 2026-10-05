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
import { EmailCampaignAudience, EmailCampaignSegment } from './schemas/email-campaign.schema';
import { newsletterUnsubscribeUrl } from '@/newsletter/newsletter-consent.util';
import { storePublicUrl } from '@/newsletter/marketing-email.util';
import { EmailService } from '@/otp/services/email.service';
import { campaignLinkTargets, renderCampaignEmail } from './campaign-email.util';

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
    private readonly emailService: EmailService,
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

  /** Resolved fresh every time a campaign actually fires. Marketing email
   *  only ever goes to this store's own *subscribers* — an active
   *  NewsletterSubscriber row for (storeId, email), i.e. someone who opted
   *  in on this store's storefront/checkout or whom the seller marked as
   *  opted-in. Having ordered once is not consent (GDPR/CAN-SPAM, and it's
   *  how Shopify Email works too). The audience value narrows that list:
   *    - 'all'       every subscriber, customer or not (e.g. footer signups)
   *    - 'buyers'    subscribers who have ordered from this store
   *    - 'abandoned' subscribers with an unrecovered abandoned checkout
   *  Deduped by email, since the same person can hold more than one account
   *  with the same email across legacy/per-store rows. */
  private async resolveAudience(storeId: string, audience: EmailCampaignAudience, segment?: EmailCampaignSegment | null) {
    const { userModel, orderModel, checkoutModel, newsletterSubscriberModel } = this.r;

    const subscribers = await newsletterSubscriberModel
      .find({ storeId, isActive: true })
      .select('email userId unsubscribeToken')
      .lean();
    if (subscribers.length === 0) return [];

    let allowedUserIds: Set<string> | null = null;
    if (audience === 'buyers') {
      allowedUserIds = new Set((await orderModel.distinct('userId', { 'sellerOrders.storeId': storeId })).map(String));
    } else if (audience === 'abandoned') {
      allowedUserIds = new Set((await checkoutModel.distinct('userId', {
        'items.storeId': storeId,
        abandonedEmailSentAt: { $ne: null },
        recoveredAt: null,
        isDelete: false,
      })).map(String));
    }

    // Accounts behind the subscribers' emails — for the {{customerName}}
    // merge tag, the deleted-account check, and the buyers/abandoned filter.
    // Guest-checkout rows have a synthetic login email — they match a subscriber by their real `contactEmail`.
    const subscriberEmails = subscribers.map((s) => s.email);
    const users = await userModel
      .find({ $or: [{ email: { $in: subscriberEmails } }, { isGuest: true, storeId, contactEmail: { $in: subscriberEmails } }] })
      .select('name email contactEmail isGuest isDelete')
      .lean();
    const usersByEmail = new Map<string, any[]>();
    for (const u of users as any[]) {
      const key = u.isGuest ? u.contactEmail : u.email;
      if (!key) continue;
      const list = usersByEmail.get(key) ?? [];
      list.push(u);
      usersByEmail.set(key, list);
    }

    const recipients: { userId: string | null; accountIds: string[]; email: string; name: string; unsubscribeToken: string }[] = [];
    const seen = new Set<string>();
    for (const sub of subscribers as any[]) {
      if (seen.has(sub.email)) continue;
      const accounts = usersByEmail.get(sub.email) ?? [];
      if (accounts.length > 0 && accounts.every((u) => u.isDelete === true)) continue;
      const live = accounts.filter((u) => u.isDelete !== true);
      let account = live.find((u) => String(u._id) === sub.userId) ?? live[0] ?? null;
      if (allowedUserIds) {
        account = live.find((u) => allowedUserIds!.has(String(u._id))) ?? null;
        if (!account) continue;
      }
      seen.add(sub.email);
      recipients.push({
        userId: account ? String(account._id) : sub.userId ?? null,
        accountIds: live.map((u) => String(u._id)),
        email: sub.email,
        name: account?.name || 'there',
        unsubscribeToken: sub.unsubscribeToken,
      });
    }
    return this.applySegment(storeId, recipients, segment);
  }

  private hasSegment(segment?: EmailCampaignSegment | null): segment is EmailCampaignSegment {
    if (!segment) return false;
    return segment.minOrders != null || segment.minTotalSpent != null || segment.orderedWithinDays != null
      || segment.notOrderedWithinDays != null || (segment.tags?.length ?? 0) > 0;
  }

  /** Narrows resolved recipients by order history / customer tags at this
   *  store. A subscriber with no account counts as zero orders and no tags. */
  private async applySegment<T extends { email: string; accountIds: string[] }>(
    storeId: string, recipients: T[], segment?: EmailCampaignSegment | null,
  ): Promise<T[]> {
    if (!this.hasSegment(segment) || recipients.length === 0) return recipients;
    const allIds = [...new Set(recipients.flatMap((r) => r.accountIds))];

    const needsOrders = segment.minOrders != null || segment.minTotalSpent != null
      || segment.orderedWithinDays != null || segment.notOrderedWithinDays != null;
    const stats = new Map<string, { count: number; spent: number; last: Date | null }>();
    if (needsOrders && allIds.length) {
      const rows = await this.r.orderModel.aggregate([
        { $match: { userId: { $in: allIds }, isDelete: false, 'sellerOrders.storeId': storeId } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.storeId': storeId } },
        { $group: { _id: '$userId', count: { $sum: 1 }, spent: { $sum: '$sellerOrders.subtotal' }, last: { $max: '$createdAt' } } },
      ]);
      for (const row of rows as any[]) stats.set(String(row._id), { count: row.count, spent: row.spent ?? 0, last: row.last ?? null });
    }

    const tagged = new Set<string>();
    if (segment.tags?.length && allIds.length) {
      const wanted = segment.tags.map((t) => t.trim()).filter(Boolean);
      const metas = await this.r.storeCustomerMetaModel.find({ storeId, userId: { $in: allIds }, tags: { $in: wanted } }).select('userId').lean();
      for (const m of metas as any[]) tagged.add(String(m.userId));
    }

    const now = Date.now();
    return recipients.filter((r) => {
      const agg = r.accountIds.reduce(
        (acc, id) => {
          const s = stats.get(id);
          if (!s) return acc;
          return { count: acc.count + s.count, spent: acc.spent + s.spent, last: !acc.last || (s.last && s.last > acc.last) ? s.last : acc.last };
        },
        { count: 0, spent: 0, last: null as Date | null },
      );
      if (segment.minOrders != null && agg.count < segment.minOrders) return false;
      if (segment.minTotalSpent != null && agg.spent < segment.minTotalSpent) return false;
      if (segment.orderedWithinDays != null && (!agg.last || now - new Date(agg.last).getTime() > segment.orderedWithinDays * 86_400_000)) return false;
      if (segment.notOrderedWithinDays != null && agg.last && now - new Date(agg.last).getTime() < segment.notOrderedWithinDays * 86_400_000) return false;
      if (segment.tags?.length && !r.accountIds.some((id) => tagged.has(id))) return false;
      return true;
    });
  }

  /** Lets the frontend show "~N recipients" before the seller actually
   *  commits to sending — same resolution logic, no side effects. */
  async previewAudience(sellerId: string, storeId: string, audience: EmailCampaignAudience, segment?: EmailCampaignSegment | null) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const recipients = await this.resolveAudience(storeId, audience, segment);
    return { success: true, data: { recipientCount: recipients.length } };
  }

  /** "Send test email" — the campaign exactly as a subscriber would get it,
   *  to the seller's own inbox (or an address they pick). No tracking, no
   *  EmailCampaignSend row, doesn't change the campaign. */
  async sendTest(sellerId: string, storeId: string, campaignId: string, email: string | null) {
    const campaign = await this.getOwnedCampaign(storeId, sellerId, campaignId);
    if (!email) throw new BadRequestException('No email address to send the test to');
    const store = await this.r.storeModel.findById(storeId).select('name slug customDomain customDomainStatus contactEmail').lean();
    const rendered = renderCampaignEmail({
      subject: campaign.subject,
      message: campaign.message,
      customerName: 'there',
      storeName: (store as any)?.name ?? 'the store',
      designed: !!campaign.design,
      ctaUrl: storePublicUrl(store as any),
      unsubscribeUrl: '#',
    });
    const sent = await this.emailService.sendMail(email, `[Test] ${rendered.subject}`, rendered.html, (store as any)?.contactEmail ?? null);
    if (!sent) throw new BadRequestException('The test email could not be sent. Check the email settings and try again.');
    return { success: true, message: `Test email sent to ${email}` };
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
    const store = await this.r.storeModel.findById(campaign.storeId).select('name contactEmail').lean();
    const recipients = await this.resolveAudience(campaign.storeId, campaign.audience, campaign.segment);

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
        storeContactEmail: (store as any)?.contactEmail ?? null,
        designed: !!campaign.design,
        unsubscribeUrl: newsletterUnsubscribeUrl(rcpt.unsubscribeToken),
        subject: campaign.subject,
        message: campaign.message,
      }, {
        // Shopify-Email-style retry of transient SMTP failures: 4 tries total,
        // waiting 2 / 4 / 8 minutes in between.
        attempts: 4,
        backoff: { type: 'exponential', delay: 120_000 },
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
    // Checked up front so an empty audience leaves the draft editable
    // instead of burning it as 'failed' (executeSend's own guard still
    // covers the scheduled path, where there's no one to tell).
    if ((await this.resolveAudience(storeId, campaign.audience, campaign.segment)).length === 0) {
      throw new BadRequestException(
        'No subscribers in this audience yet. Only customers who opted in to marketing emails can receive campaigns.',
      );
    }
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

  async getSendState(sendId: string) {
    return this.r.emailCampaignSendModel.findById(sendId).select('sentAt failedAt').lean() as Promise<{ sentAt?: Date | null; failedAt?: Date | null } | null>;
  }

  /** Idempotent: a send resolves exactly once (sent XOR failed), so a BullMQ
   *  redelivery can never double-count or flip a sent recipient to failed. */
  async markSendResult(sendId: string, campaignId: string, success: boolean, error?: string) {
    const res = await this.r.emailCampaignSendModel.updateOne(
      { _id: sendId, sentAt: null, failedAt: null },
      success ? { $set: { sentAt: new Date(), error: null } } : { $set: { failedAt: new Date(), error: error ?? 'send failed' } },
    );
    if (res.modifiedCount > 0) {
      await this.r.emailCampaignModel.updateOne(
        { _id: campaignId },
        success ? { $inc: { sentCount: 1 } } : { $inc: { failedCount: 1 } },
      );
    }
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
  /** Records the first click per recipient (clickCount = unique clickers) and
   *  returns where to send them: `target` when it's a link that really is in
   *  this campaign's email (never an arbitrary URL — no open redirect), else
   *  the store's storefront. */
  async trackClick(sendId: string, target?: string | null): Promise<string> {
    let send: any = null;
    try {
      send = await this.r.emailCampaignSendModel.findOneAndUpdate(
        { _id: sendId, clickedAt: null },
        { $set: { clickedAt: new Date() } },
      );
      if (send) await this.r.emailCampaignModel.updateOne({ _id: send.campaignId }, { $inc: { clickCount: 1 } });
      // Repeat click — still needs the send to know which store/campaign.
      else send = await this.r.emailCampaignSendModel.findById(sendId).lean();
    } catch {
      // malformed/unknown id — fall through to the platform default below
    }

    if (send && target) {
      const campaign = await this.r.emailCampaignModel.findById(send.campaignId).select('message').lean().catch(() => null);
      if (campaign && campaignLinkTargets((campaign as any).message).has(target)) return target;
    }

    const storeId = send?.storeId;
    // The store's own storefront (custom domain or subdomain) — there is no
    // `/store/:slug` route on the platform site.
    const store = storeId ? await this.r.storeModel.findById(storeId).select('slug customDomain customDomainStatus').lean().catch(() => null) : null;
    return storePublicUrl(store as any) ?? PLATFORM_ORIGIN;
  }
}
