/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron } from '@nestjs/schedule';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { RedisService } from '../redis/redis.service';
import { CustomerSegmentsService } from '../customer-segments/customer-segments.service';
import { WhatsAppCloudProvider } from '../integrations/providers/whatsapp-cloud.provider';
import { QUEUE_NAMES } from '../queues/queue.constants';
import { pageOf } from '../common/paging';
import { MessagingCampaign, MessagingCampaignDocument, MessagingConsent, MessagingConsentDocument, MessagingMessage, MessagingMessageDocument, WhatsAppTemplate, WhatsAppTemplateDocument } from './messaging.schema';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { SmsGatewayService } from './sms-gateway.service';
import { MAX_SMS_TEXT, smsSegments, withStopFooter } from './sms.util';
import type { Channel } from './messaging-rules.util';
import { MessagingConsentService } from './messaging-consent.service';
import { canSendTemplate, chunk, contactKey, countsFromStatuses, DEFAULT_DAILY_LIMIT, isTransientSendError, MAX_BATCH, remainingToday } from './messaging-rules.util';

export const MESSAGING_SEND_JOB = 'send-batch';
const MAX_ATTEMPTS = 3;
const STUCK_MINUTES = 20;
const isOid = (v: any) => typeof v === 'string' && Types.ObjectId.isValid(v);
const clean = (v: any, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Marketing campaigns over WhatsApp: recipients come from consent (and optionally a segment), sends are throttled to the daily contact limit. */
@Injectable()
export class MessagingCampaignsService {
  private readonly log = new Logger(MessagingCampaignsService.name);
  constructor(
    @InjectModel(MessagingCampaign.name) private readonly campaigns: Model<MessagingCampaignDocument>,
    @InjectModel(MessagingMessage.name) private readonly messages: Model<MessagingMessageDocument>,
    @InjectModel(MessagingConsent.name) private readonly consents: Model<MessagingConsentDocument>,
    @InjectModel(WhatsAppTemplate.name) private readonly templates: Model<WhatsAppTemplateDocument>,
    @InjectQueue(QUEUE_NAMES.MESSAGING_SEND) private readonly queue: Queue,
    private readonly db: DatabaseService,
    private readonly activity: ActivityLogService,
    private readonly redis: RedisService,
    private readonly consentSvc: MessagingConsentService,
    private readonly templatesSvc: WhatsAppTemplatesService,
    private readonly segments: CustomerSegmentsService,
    private readonly moduleRef: ModuleRef,
    private readonly sms: SmsGatewayService,
  ) {}

  private audit(storeId: string, actor: { id: string; role: string }, action: string, description: string, targetId: string) {
    return this.activity.log({ storeId, category: 'marketing', action, description, actorId: actor.id, actorRole: actor.role, targetId, targetType: 'messaging_campaign' } as any).catch(() => undefined);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  private async input(storeId: string, body: any, partial: boolean) {
    const data: any = {};
    const channel: Channel = body.channel === 'sms' ? 'sms' : 'whatsapp';
    if (!partial) data.channel = channel;
    if (body.name !== undefined || !partial) { data.name = clean(body.name, 120); if (!data.name) throw new BadRequestException('Campaign name is required'); }
    if (channel === 'sms' && (body.smsText !== undefined || !partial)) {
      const text = clean(body.smsText, MAX_SMS_TEXT);
      if (!text) throw new BadRequestException('Write the SMS text');
      data.smsText = text;
    }
    if (channel === 'whatsapp' && (body.templateId !== undefined || !partial)) {
      if (!isOid(body.templateId)) throw new BadRequestException('Choose an approved template');
      const t: any = await this.templates.findOne({ _id: body.templateId, storeId }).lean();
      if (!t) throw new BadRequestException('Template not found in this store');
      data.templateId = String(t._id);
      const params = Array.isArray(body.params) ? body.params.map((p: any) => clean(p, 100)) : [];
      if (params.length !== t.paramCount || params.some((p: string) => !p)) throw new BadRequestException(`This template has ${t.paramCount} placeholder(s): give a value for each`);
      data.params = params;
    }
    if (body.segmentId !== undefined) {
      if (body.segmentId === null || body.segmentId === '') data.segmentId = null;
      else if (!isOid(body.segmentId) || (await this.segments.loadFilter(storeId, body.segmentId)) === null) throw new BadRequestException('Segment not found in this store');
      else data.segmentId = body.segmentId;
    }
    if (body.dailyLimit !== undefined) {
      if (body.dailyLimit === null) data.dailyLimit = null;
      else if (!Number.isInteger(body.dailyLimit) || body.dailyLimit < 1 || body.dailyLimit > 100_000) throw new BadRequestException('Daily limit must be a whole number between 1 and 100000');
      else data.dailyLimit = body.dailyLimit;
    }
    return data;
  }

  async create(storeId: string, actor: { id: string; role: string }, body: any) {
    const data = await this.input(storeId, body ?? {}, false);
    const c = await this.campaigns.create({ ...data, storeId, status: 'draft', createdBy: actor.id });
    await this.audit(storeId, actor, 'messaging_campaign_created', `${data.channel === 'sms' ? 'SMS' : 'WhatsApp'} campaign "${c.name}" created`, String(c._id));
    return c.toObject();
  }

  async update(storeId: string, actor: { id: string; role: string }, id: string, body: any) {
    const c = await this.find(storeId, id);
    if (c.status !== 'draft') throw new BadRequestException('Only a draft campaign can be edited');
    const data = await this.input(storeId, { ...(body ?? {}), channel: c.channel }, true);
    const r = await this.campaigns.findOneAndUpdate({ _id: id, storeId, status: 'draft' }, { $set: data }, { new: true }).lean();
    if (!r) throw new ConflictException('This campaign was just started');
    await this.audit(storeId, actor, 'messaging_campaign_updated', `Campaign "${(r as any).name}" updated`, id);
    return r;
  }

  private async find(storeId: string, id: string): Promise<any> {
    if (!isOid(id)) throw new NotFoundException('Campaign not found');
    const c = await this.campaigns.findOne({ _id: id, storeId }).lean();
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async list(storeId: string, q: { page?: any; limit?: any }) {
    const { page, limit, skip } = pageOf(q.page, q.limit);
    const [items, total] = await Promise.all([this.campaigns.find({ storeId }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(), this.campaigns.countDocuments({ storeId })]);
    return { items, total, page, limit };
  }

  async deleteDraft(storeId: string, actor: { id: string; role: string }, id: string) {
    const r = await this.campaigns.deleteOne({ _id: id, storeId, status: 'draft' });
    if (!r.deletedCount) throw new BadRequestException('Only a draft campaign can be deleted');
    await this.audit(storeId, actor, 'messaging_campaign_deleted', 'Draft campaign deleted', id);
    return { success: true };
  }

  // ── launch ────────────────────────────────────────────────────────────────
  /**
   * Starts a campaign: only an approved template, only opted-in contacts (a segment narrows who), one message row per contact (so a contact is
   * never messaged twice by the same campaign), contacts without consent are recorded as skipped. Sending is throttled, see `dispatch`.
   */
  async launch(storeId: string, actor: { id: string; role: string }, id: string) {
    const campaign = await this.find(storeId, id);
    if (campaign.status !== 'draft') throw new BadRequestException('This campaign was already started');
    if (campaign.channel === 'sms') {
      if (!(await this.sms.activeConfig(storeId))) throw new BadRequestException('Set up, test and switch on your SMS gateway first.');
    } else {
      const template: any = await this.templates.findOne({ _id: campaign.templateId, storeId }).lean();
      if (!template || !canSendTemplate(template.status)) throw new BadRequestException('Marketing messages can only use a template that WhatsApp has approved. Sync your templates, or wait for approval.');
      await this.templatesSvc.access(storeId); // a connected WhatsApp account is required
    }

    // Atomic claim: two clicks start it once.
    const claimed = await this.campaigns.findOneAndUpdate({ _id: id, storeId, status: 'draft' }, { $set: { status: 'sending', startedAt: new Date() } }, { new: true }).lean();
    if (!claimed) throw new ConflictException('This campaign was just started');
    try {
      const rows = await this.recipients(storeId, campaign.segmentId, campaign.channel);
      if (rows.length === 0) throw new BadRequestException('No opted-in contacts to message');
      await this.messages.insertMany(rows.map((r) => ({ storeId, campaignId: id, channel: campaign.channel, contactKey: r.key, customerId: r.customerId, customerName: r.name, status: r.status })), { ordered: false }).catch((e: any) => { if (e?.code !== 11000 && !e?.writeErrors) throw e; });
    } catch (e) {
      await this.campaigns.updateOne({ _id: id }, { $set: { status: 'draft', startedAt: null } });
      throw e;
    }
    await this.audit(storeId, actor, 'messaging_campaign_started', `${campaign.channel === 'sms' ? 'SMS' : 'WhatsApp'} campaign "${campaign.name}" started`, id);
    await this.dispatch(id);
    return this.stats(storeId, id);
  }

  /** Contacts to message with their starting status. No segment: every opted-in contact. A segment: its members with a phone, split by consent. */
  private async recipients(storeId: string, segmentId: string | null, channel: Channel = 'whatsapp'): Promise<{ key: string; customerId: string | null; name: string | null; status: string }[]> {
    if (!segmentId) {
      const rows: any[] = await this.consents.find({ storeId, channel, status: 'opted_in' }).select('contactKey customerId name').limit(50_000).lean();
      return rows.map((r) => ({ key: r.contactKey, customerId: r.customerId ?? null, name: r.name ?? null, status: 'queued' }));
    }
    const members = (await this.segments.resolveContacts(storeId, segmentId)) ?? [];
    const keyed = members.map((m) => ({ ...m, key: contactKey(m.phone) })).filter((m): m is typeof m & { key: string } => !!m.key);
    const seen = new Set<string>();
    const unique = keyed.filter((m) => (seen.has(m.key) ? false : (seen.add(m.key), true)));
    const status = await this.consentSvc.statusFor(storeId, channel, unique.map((m) => m.key));
    return unique.map((m) => ({ key: m.key, customerId: m.customerId, name: m.name, status: status.get(m.key) === 'opted_in' ? 'queued' : status.get(m.key) === 'opted_out' ? 'skipped_opted_out' : 'skipped_no_consent' }));
  }

  async cancel(storeId: string, actor: { id: string; role: string }, id: string) {
    const r = await this.campaigns.updateOne({ _id: id, storeId, status: 'sending' }, { $set: { status: 'canceled', completedAt: new Date() } });
    if (!r.matchedCount) throw new BadRequestException('Only a campaign that is sending can be canceled');
    await this.messages.updateMany({ storeId, campaignId: id, status: 'queued' }, { $set: { status: 'canceled' } });
    await this.audit(storeId, actor, 'messaging_campaign_canceled', 'Campaign canceled', id);
    return this.stats(storeId, id);
  }

  // ── sending (throttled) ───────────────────────────────────────────────────
  /** Distinct contacts of this store already messaged on this channel in the last 24 h (the unit Meta's daily limit counts). */
  async contactedLast24h(storeId: string, now = new Date(), channel: Channel = 'whatsapp'): Promise<number> {
    const rows = await this.messages.aggregate([{ $match: { storeId, channel, sentAt: { $gte: new Date(now.getTime() - 86_400_000) } } }, { $group: { _id: '$contactKey' } }, { $count: 'n' }]);
    return rows[0]?.n ?? 0;
  }

  /** Claims as many queued messages as today's room allows and returns them in batches (the caller sends or enqueues each batch). */
  async claimBatches(campaignId: string, now = new Date()): Promise<string[][]> {
    const c: any = await this.campaigns.findOne({ _id: campaignId, status: 'sending' }).lean();
    if (!c) return [];
    const gatewayLimit = c.channel === 'sms' ? (await this.sms.activeConfig(c.storeId))?.dailyLimit : undefined;
    if (c.channel === 'sms' && gatewayLimit === undefined) return []; // gateway switched off: nothing leaves, the campaign waits
    const room = remainingToday(Math.min(c.dailyLimit ?? Number.MAX_SAFE_INTEGER, gatewayLimit ?? c.dailyLimit ?? DEFAULT_DAILY_LIMIT), await this.contactedLast24h(c.storeId, now, c.channel));
    if (room <= 0) return [];
    const queued: any[] = await this.messages.find({ campaignId, status: 'queued' }).sort({ _id: 1 }).limit(room).select('_id').lean();
    if (queued.length === 0) return [];
    const ids = queued.map((m) => m._id);
    await this.messages.updateMany({ _id: { $in: ids }, status: 'queued' }, { $set: { status: 'sending', sendingAt: now } });
    const claimed: any[] = await this.messages.find({ _id: { $in: ids }, status: 'sending', sendingAt: now }).select('_id').lean();
    return chunk(claimed.map((m) => String(m._id)), MAX_BATCH);
  }

  async dispatch(campaignId: string) {
    const batches = await this.claimBatches(campaignId);
    for (const ids of batches) await this.queue.add(MESSAGING_SEND_JOB, { ids });
    if (batches.length === 0) await this.finishIfDone(campaignId);
    return batches.length;
  }

  private ctxCache = new Map<string, { at: number; value: any }>();
  private async sendContext(campaign: any) {
    const key = String(campaign._id);
    const hit = this.ctxCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const [template, access, store]: any[] = await Promise.all([
      this.templates.findOne({ _id: campaign.templateId, storeId: campaign.storeId }).lean(),
      this.templatesSvc.access(campaign.storeId),
      this.db.repositories.storeModel.findById(campaign.storeId).select('name').lean(),
    ]);
    const value = { template, access, storeName: store?.name ?? '' };
    this.ctxCache.set(key, { at: Date.now(), value });
    return value;
  }

  private render(params: string[], vars: { customerName: string; storeName: string }) {
    return params.map((p) => p.replace(/\{customer_name\}/g, vars.customerName || 'there').replace(/\{store_name\}/g, vars.storeName));
  }

  /** Sends one batch of already-claimed messages. Re-checks consent for each contact at send time (a STOP that arrived meanwhile wins). */
  async sendBatch(ids: string[]): Promise<void> {
    const touched = new Set<string>();
    for (const id of ids) {
      // Atomic per-message claim: a redelivered or parallel job that finds it taken (or already handled) skips it, so no message goes out twice.
      const msg: any = await this.messages.findOneAndUpdate({ _id: id, status: 'sending', inFlight: { $ne: true } }, { $set: { inFlight: true } }, { new: true }).lean();
      if (!msg) continue;
      touched.add(msg.campaignId);
      const campaign: any = await this.campaigns.findById(msg.campaignId).lean();
      if (!campaign || campaign.status !== 'sending') { await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: 'canceled' } }); continue; }
      const consent = await this.consentSvc.statusFor(msg.storeId, campaign.channel, [msg.contactKey]);
      if (consent.get(msg.contactKey) !== 'opted_in') {
        await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: consent.get(msg.contactKey) === 'opted_out' ? 'skipped_opted_out' : 'skipped_no_consent' } });
        continue;
      }
      try {
        let res: { success: boolean; messageId?: string | null; error?: string };
        if (campaign.channel === 'sms') {
          const store: any = await this.db.repositories.storeModel.findById(msg.storeId).select('name').lean();
          const [text] = this.render([campaign.smsText ?? ''], { customerName: msg.customerName ?? '', storeName: store?.name ?? '' });
          res = await this.sms.sendMarketing(msg.storeId, msg.contactKey, text);
        } else {
          const ctx = await this.sendContext(campaign);
          if (!canSendTemplate(ctx.template?.status)) { await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: 'failed', inFlight: false, error: 'Template is not approved any more' } }); continue; }
          res = await this.moduleRef.get(WhatsAppCloudProvider, { strict: false }).sendTemplateMessage(ctx.access, msg.contactKey, {
            templateName: ctx.template.name, languageCode: ctx.template.language, bodyParams: this.render(campaign.params ?? [], { customerName: msg.customerName ?? '', storeName: ctx.storeName }),
          });
        }
        if (res.success) {
          await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: 'sent', inFlight: false, sentAt: new Date(), providerMessageId: res.messageId ?? null, error: null }, $inc: { attempts: 1 } });
        } else if (isTransientSendError(res.error) && (msg.attempts ?? 0) + 1 < MAX_ATTEMPTS) {
          await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: 'queued', inFlight: false, sendingAt: null, error: String(res.error).slice(0, 400) }, $inc: { attempts: 1 } });
        } else {
          await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: 'failed', inFlight: false, error: String(res.error ?? 'Send failed').slice(0, 400) }, $inc: { attempts: 1 } });
        }
      } catch (e: any) {
        const transient = isTransientSendError(e?.message) && (msg.attempts ?? 0) + 1 < MAX_ATTEMPTS;
        await this.messages.updateOne({ _id: id, status: 'sending' }, { $set: { status: transient ? 'queued' : 'failed', inFlight: false, sendingAt: null, error: String(e?.message ?? 'Send failed').slice(0, 400) }, $inc: { attempts: 1 } });
      }
    }
    for (const cid of touched) await this.finishIfDone(cid);
  }

  private async finishIfDone(campaignId: string) {
    const open = await this.messages.exists({ campaignId, status: { $in: ['queued', 'sending'] } });
    if (!open) await this.campaigns.updateOne({ _id: campaignId, status: 'sending' }, { $set: { status: 'completed', completedAt: new Date() } });
  }

  /** A message stuck in `sending` (process died mid-send): the outcome is unknown, so it is failed, never re-sent (no duplicate marketing message). */
  async failStuck(now = new Date()): Promise<number> {
    const r = await this.messages.updateMany({ status: 'sending', sendingAt: { $lt: new Date(now.getTime() - STUCK_MINUTES * 60_000) } }, { $set: { status: 'failed', error: 'Unknown outcome (the server stopped while sending). Not retried to avoid a duplicate message.' } });
    return r.modifiedCount ?? 0;
  }

  /** Every hour: fail stuck sends and send what the daily limit now allows (a campaign larger than the limit continues the next day). */
  @Cron('50 * * * *')
  async cron() {
    const r = await this.redis.withLock('cron-lock:messaging-campaigns', 20 * 60_000, async () => {
      await this.failStuck();
      const open: any[] = await this.campaigns.find({ status: 'sending' }).select('_id').limit(200).lean();
      for (const c of open) await this.dispatch(String(c._id)).catch((e: any) => this.log.warn(`Dispatch of campaign ${c._id} failed: ${e?.message}`));
    });
    if (r === 'lock_not_acquired') this.log.debug('Skipped messaging cron: another instance holds the lock (or Redis is unavailable)');
  }

  // ── reporting ────────────────────────────────────────────────────────────
  async stats(storeId: string, id: string) {
    const campaign = await this.find(storeId, id);
    const rows = await this.messages.aggregate([{ $match: { storeId, campaignId: id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const counts = countsFromStatuses(Object.fromEntries(rows.map((r: any) => [r._id, r.n])));
    if (campaign.channel === 'sms') {
      const seg = smsSegments(withStopFooter(campaign.smsText ?? ''));
      return { campaign, ...counts, billing: { billedUnit: 'SMS part sent through your own gateway', partsPerMessage: seg.segments, encoding: seg.encoding, estimatedParts: seg.segments * counts.sent, note: 'Your SMS provider bills you per SMS part. A message with Urdu or emoji is sent as unicode (70 characters per part). The opt-out line is added to every message.' } };
    }
    return {
      campaign, ...counts,
      // Meta bills per delivered template message; the rate depends on the country and category. No price is stated here: see Meta's pricing page.
      billing: { billedUnit: 'delivered template message', deliveredMessages: counts.delivered, note: 'WhatsApp charges your WhatsApp Business account for each delivered marketing template message. The rate depends on the recipient country; check Meta\'s current pricing.' },
    };
  }

  async messageLog(storeId: string, id: string, q: { page?: any; limit?: any; status?: string }) {
    await this.find(storeId, id);
    const { page, limit, skip } = pageOf(q.page, q.limit, 100);
    const filter: any = { storeId, campaignId: id };
    if (typeof q.status === 'string' && q.status) filter.status = q.status;
    const [items, total] = await Promise.all([this.messages.find(filter).sort({ _id: 1 }).skip(skip).limit(limit).select('-__v').lean(), this.messages.countDocuments(filter)]);
    return { items, total, page, limit };
  }
}
