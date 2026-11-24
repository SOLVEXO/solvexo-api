/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { randomBytes } from 'crypto';
import { API_PUBLIC_ORIGIN } from '../common/api-origin';
import { decryptCredential, encryptCredential, maskSecret } from '../common/credential-encryption.util';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../otp/services/email.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { escapeEmailText, solvexoEmail } from '../notifications/templates/notification-email.template';
import { SalesLead } from './schemas/sales-lead.schema';
import { SalesSettings, SalesSettingsDocument } from './schemas/sales-settings.schema';
import { SalesOpsService, type LeadListQuery } from './sales-ops.service';
import { type SalesActor, leadScope } from './sales-ops.util';
import {
  BREVO_CUSTOM_ATTRIBUTES,
  BREVO_FOLDER_NAME,
  BREVO_LIST_NAME,
  WITHDRAW_ACTIVITY,
  brevoAttributes,
  brevoCsvFilename,
  brevoErrorText,
  buildBrevoCsv,
  parseBrevoWebhook,
  safeEqual,
  signConsentToken,
  splitName,
  verifyConsentToken,
} from './sales-brevo.util';

const BREVO = 'https://api.brevo.com/v3';
/** Most leads one sync run sends to Brevo (the job runs every 10 minutes). */
export const SYNC_BATCH = 200;
/** Most permission emails one request sends. */
export const MAX_CONSENT_REQUESTS = 500;
const MAX_EXPORT = 50_000;
const MAX_PAGES = 20;

type FetchFn = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
interface BrevoResult { ok: boolean; status: number | null; data: any; error: string | null }
export interface AuditCtx { adminId?: string | null; adminEmail?: string | null; ip?: string | null; userAgent?: string | null }

const siteUrl = () => (process.env.PUBLIC_SITE_URL || 'https://solvexo.store').replace(/\/+$/, '');
const isId = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s);
/** A 4xx other than 429 will fail the same way next time: stop retrying that lead. */
const permanent = (status: number | null) => status !== null && status >= 400 && status < 500 && status !== 429;
const withEmail = { email: { $ne: null } };
/** Never asked (leads saved before consent existed have no status: they count as never asked). */
const NOT_ASKED = { 'marketingConsent.status': { $nin: ['asked', 'granted', 'withdrawn'] } };

/**
 * Sales Ops → Brevo marketing sync. Leads who agreed to marketing email ('granted') are kept in one Brevo list
 * ("Solvexo – Sales leads") with their name, business, city, WhatsApp, stage, source and campaign; leads who withdraw
 * are taken off it and never added back. Brevo tells us about unsubscribes / spam reports / hard bounces through a
 * webhook with a secret URL. The API key is stored encrypted and never leaves the server.
 */
@Injectable()
export class SalesBrevoService {
  private readonly logger = new Logger(SalesBrevoService.name);
  /** Replaced in tests. Every call: no redirects, 15 s timeout. */
  fetchFn: FetchFn = (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) }) as any;

  constructor(
    private readonly sales: SalesOpsService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    // Loosely typed: the filters below use dotted paths into marketingConsent / brevo.
    @InjectModel(SalesLead.name) private readonly leads: Model<any>,
    @InjectModel(SalesSettings.name) private readonly settings: Model<SalesSettingsDocument>,
    @Optional() private readonly activityLog?: ActivityLogService,
  ) {}

  // ── Connection (managers) ──────────────────────────────────────────────────

  async status() {
    const s = await this.load();
    let keyHint: string | null = null;
    if (s.brevoApiKeyEnc) {
      try { keyHint = maskSecret(decryptCredential(s.brevoApiKeyEnc, 'INTEGRATIONS')); } catch { keyHint = '(cannot be read: re-enter it)'; }
    }
    const connected = !!(s.brevoApiKeyEnc && s.brevoListId);
    const base = { isDelete: false, ...withEmail };
    const [granted, synced, pending, failed, asked, withdrawn] = await Promise.all([
      this.leads.countDocuments({ ...base, 'marketingConsent.status': 'granted' }),
      this.leads.countDocuments({ ...base, 'marketingConsent.status': 'granted', 'brevo.syncedAt': { $ne: null }, 'brevo.pending': { $ne: true }, 'brevo.error': null }),
      this.leads.countDocuments({ isDelete: false, 'brevo.pending': true }),
      this.leads.countDocuments({ isDelete: false, 'brevo.error': { $ne: null } }),
      this.leads.countDocuments({ ...base, 'marketingConsent.status': 'asked' }),
      this.leads.countDocuments({ isDelete: false, 'marketingConsent.status': 'withdrawn' }),
    ]);
    return {
      success: true,
      data: {
        connected,
        accountEmail: s.brevoAccountEmail ?? null,
        keyHint,
        listId: s.brevoListId ?? null,
        listName: s.brevoListName ?? null,
        connectedAt: s.brevoConnectedAt ?? null,
        lastSyncAt: s.brevoLastSyncAt ?? null,
        lastError: s.brevoLastError ?? null,
        webhookUrl: connected && s.brevoWebhookSecret ? `${API_PUBLIC_ORIGIN}/api/sales/brevo/webhook/${s.brevoWebhookSecret}` : null,
        counts: { granted, synced, pending, failed, asked, withdrawn },
      },
    };
  }

  /** Checks the key, creates our contact fields, finds or creates the "Solvexo" folder and our list, saves (key encrypted), queues every consented lead. */
  async connect(apiKeyInput: string, ctx: AuditCtx = {}) {
    const apiKey = String(apiKeyInput ?? '').trim();
    if (!apiKey || /\s/.test(apiKey)) throw new BadRequestException('Paste your Brevo API key (Brevo → SMTP & API → API keys).');

    const account = await this.call('GET', '/account', apiKey);
    if (account.status === 401 || account.status === 403) throw new BadRequestException("Brevo didn't accept that API key.");
    if (!account.ok) throw new BadRequestException(`Couldn't check the key with Brevo: ${account.error}`);

    for (const name of BREVO_CUSTOM_ATTRIBUTES) {
      const r = await this.call('POST', `/contacts/attributes/normal/${name}`, apiKey, { type: 'text' });
      // 400 / 409 "already exists" is fine: the field is there.
      if (!r.ok && r.status !== 400 && r.status !== 409) throw new BadRequestException(`Brevo would not create the contact field ${name}: ${r.error}`);
    }

    const folder = await this.findByName('/contacts/folders', 'folders', BREVO_FOLDER_NAME, apiKey);
    let folderId: number | null = folder?.id ?? null;
    if (!folderId) {
      const r = await this.call('POST', '/contacts/folders', apiKey, { name: BREVO_FOLDER_NAME });
      if (!r.ok || !r.data?.id) throw new BadRequestException(`Brevo would not create the "${BREVO_FOLDER_NAME}" folder: ${r.error ?? 'no id returned'}`);
      folderId = Number(r.data.id);
    }
    const list = await this.findByName('/contacts/lists', 'lists', BREVO_LIST_NAME, apiKey);
    let listId: number | null = list?.id ?? null;
    if (!listId) {
      const r = await this.call('POST', '/contacts/lists', apiKey, { name: BREVO_LIST_NAME, folderId });
      if (!r.ok || !r.data?.id) throw new BadRequestException(`Brevo would not create the "${BREVO_LIST_NAME}" list: ${r.error ?? 'no id returned'}`);
      listId = Number(r.data.id);
    }

    const s = await this.load();
    const accountEmail = typeof account.data?.email === 'string' ? account.data.email : null;
    await this.settings.updateOne({ key: 'default' }, {
      $set: {
        brevoApiKeyEnc: encryptCredential(apiKey, 'INTEGRATIONS'),
        brevoAccountEmail: accountEmail,
        brevoListId: listId,
        brevoListName: BREVO_LIST_NAME,
        brevoFolderId: folderId,
        brevoConnectedAt: new Date(),
        brevoLastError: null,
        // Kept across reconnects so the webhook already set up in Brevo keeps working.
        brevoWebhookSecret: s.brevoWebhookSecret || randomBytes(16).toString('hex'),
      },
    }, { upsert: true });
    const queued = await this.queueAll(['granted']);
    this.audit(ctx, 'sales.brevo.connect', `Connected Brevo (${accountEmail ?? 'account'}), list #${listId}; ${queued} consented lead(s) queued`, { accountEmail, listId });
    return this.status();
  }

  /** Forgets the key and the list (consent and sync history stay on the leads). */
  async disconnect(ctx: AuditCtx = {}) {
    await this.settings.updateOne({ key: 'default' }, {
      $set: { brevoApiKeyEnc: null, brevoAccountEmail: null, brevoListId: null, brevoListName: null, brevoFolderId: null, brevoConnectedAt: null, brevoLastError: null },
    });
    this.audit(ctx, 'sales.brevo.disconnect', 'Disconnected Brevo');
    return this.status();
  }

  // ── Sync ─────────────────────────────────────────────────────────────────

  @Cron('*/10 * * * *')
  async syncJob() {
    await this.redis.withLock('cron-lock:sales-brevo-sync', 9 * 60_000, async () => {
      const r = await this.syncBatch();
      if (r.synced || r.failed) this.logger.log(`Sales Ops → Brevo: ${r.synced} synced, ${r.failed} failed`);
    });
  }

  /** "Sync now": queues every granted / withdrawn lead with an email and runs one batch straight away. */
  async syncNow(ctx: AuditCtx = {}) {
    const queued = await this.queueAll(['granted', 'withdrawn']);
    const r = await this.syncBatch();
    this.audit(ctx, 'sales.brevo.sync', `Brevo sync: ${queued} queued, ${r.synced} synced, ${r.failed} failed`);
    return { success: true, data: { queued, synced: r.synced, failed: r.failed } };
  }

  /**
   * One run over pending leads (oldest change first, at most 200). Granted → upsert the contact into our list;
   * withdrawn → take them off it; anything else just clears the flag. Nothing is sent (leads stay pending) while
   * Brevo isn't connected, or when Brevo rejects the key (the error is shown in the settings instead).
   */
  async syncBatch(limit = SYNC_BATCH): Promise<{ synced: number; failed: number }> {
    const s = await this.load();
    if (!s.brevoApiKeyEnc || !s.brevoListId) return { synced: 0, failed: 0 };
    let apiKey: string;
    try { apiKey = decryptCredential(s.brevoApiKeyEnc, 'INTEGRATIONS'); } catch {
      await this.saveRun('The saved Brevo API key cannot be read: connect Brevo again.');
      return { synced: 0, failed: 0 };
    }
    const listId = Number(s.brevoListId);
    const rows: any[] = await this.leads.find({ isDelete: false, 'brevo.pending': true }).sort({ updatedAt: 1 }).limit(Math.min(limit, SYNC_BATCH)).lean();
    let synced = 0, failed = 0;
    let lastError: string | null = null;
    for (const lead of rows) {
      const status = lead.marketingConsent?.status ?? 'none';
      let r: BrevoResult | null = null;
      if (lead.email && status === 'granted') {
        r = await this.call('POST', '/contacts', apiKey, { email: lead.email, attributes: brevoAttributes(lead), listIds: [listId], updateEnabled: true });
      } else if (lead.email && status === 'withdrawn') {
        r = await this.call('POST', `/contacts/lists/${listId}/contacts/remove`, apiKey, { emails: [lead.email] });
        // Not in the list / not in Brevo at all: there is nothing to remove, which is the outcome we want.
        if (!r.ok && (r.status === 400 || r.status === 404)) r = { ...r, ok: true };
      }
      if (r && (r.status === 401 || r.status === 403)) {
        lastError = "Brevo didn't accept the saved API key: connect Brevo again.";
        break; // the key, not the lead: keep everything pending
      }
      // Guarded on updatedAt: a lead edited while we were talking to Brevo stays pending for the next run.
      // timestamps:false so a sync never reorders the leads list ("recently updated").
      const same = { _id: lead._id, updatedAt: lead.updatedAt };
      if (!r || r.ok) {
        if (r) synced++;
        const done = await this.leads.updateOne(same, { $set: { 'brevo.pending': false, 'brevo.error': null, ...(r ? { 'brevo.syncedAt': new Date() } : {}) } }, { timestamps: false });
        if (!done.matchedCount && r) await this.leads.updateOne({ _id: lead._id }, { $set: { 'brevo.syncedAt': new Date(), 'brevo.error': null } }, { timestamps: false });
      } else {
        failed++;
        const error = r.error ?? brevoErrorText(r.status, null, apiKey); // already short and key-free (see call())
        lastError = error;
        await this.leads.updateOne({ _id: lead._id }, { $set: { 'brevo.error': error, ...(permanent(r.status) ? { 'brevo.pending': false } : {}) } }, { timestamps: false });
      }
    }
    await this.saveRun(lastError);
    return { synced, failed };
  }

  // ── CSV export (managers) ─────────────────────────────────────────────────

  /** The Brevo import file for the leads the list shows with these filters, keeping only consented leads with an email. */
  async exportCsv(actor: SalesActor, q: LeadListQuery, ctx: AuditCtx = {}) {
    const filename = brevoCsvFilename();
    if (q.consent && q.consent !== 'granted') {
      this.audit(ctx, 'sales.leads.export_brevo', 'Exported 0 consented lead(s) for Brevo', { count: 0 });
      return { filename, csv: buildBrevoCsv([]), count: 0 };
    }
    const filter = { ...this.sales.leadFilter(actor, q), 'marketingConsent.status': 'granted', ...withEmail };
    const rows: any[] = await this.leads.find(filter).sort({ createdAt: 1 }).limit(MAX_EXPORT)
      .select('name businessName email phone city stage source utm marketingConsent').lean();
    this.audit(ctx, 'sales.leads.export_brevo', `Exported ${rows.length} consented lead(s) for Brevo`, { count: rows.length });
    return { filename, csv: buildBrevoCsv(rows), count: rows.length };
  }

  // ── Asking for permission (managers) ──────────────────────────────────────

  /**
   * Sends each eligible lead ONE "Can we keep you posted?" email: they need an email and consent 'none' (leads already
   * asked, granted or withdrawn are skipped). With `leadIds`: those leads. Without: every lead the list filters match.
   * At most 500 a call; `more` says how many eligible leads are left for the next call.
   *
   * The leads are marked 'asked' first and the emails go out in the background, so the request returns at once (SMTP
   * takes a few seconds per email) and a repeat click or retry never emails anyone twice. A failed send puts the lead
   * back to 'none' so it can be asked again.
   */
  async requestConsent(actor: SalesActor, input: { leadIds?: string[]; filters?: LeadListQuery }, ctx: AuditCtx = {}) {
    const eligible = { $and: [{ isDelete: false, ...leadScope(actor) }, withEmail, NOT_ASKED] };
    let rows: any[];
    let skipped = 0;
    let more = 0;
    if (Array.isArray(input.leadIds)) {
      const ids = [...new Set(input.leadIds.filter(isId))].slice(0, MAX_CONSENT_REQUESTS);
      rows = ids.length ? await this.leads.find({ $and: [...eligible.$and, { _id: { $in: ids } }] }).select('name businessName email marketingConsent').lean() : [];
      skipped = input.leadIds.length - rows.length;
    } else {
      const filter = { $and: [this.sales.leadFilter(actor, input.filters ?? {}), withEmail, NOT_ASKED] };
      rows = await this.leads.find(filter).sort({ createdAt: 1 }).limit(MAX_CONSENT_REQUESTS).select('name businessName email marketingConsent').lean();
      more = Math.max(0, (await this.leads.countDocuments(filter)) - rows.length);
    }
    const now = new Date();
    const claimed: any[] = [];
    for (const lead of rows) {
      // Only this call's own claim counts, so two clicks at once can't both email the same lead.
      const r: any = await this.leads.updateOne({ $and: [{ _id: lead._id }, NOT_ASKED] }, { $set: { 'marketingConsent.status': 'asked', 'marketingConsent.askedAt': now } });
      if (Number(r?.modifiedCount ?? r?.matchedCount ?? 0) > 0) claimed.push(lead); else skipped++;
    }
    this.consentRun = this.deliverConsentEmails(actor, claimed, ctx);
    return { success: true, data: { sent: claimed.length, skipped, more } };
  }

  /** The background half of requestConsent (kept on the service so tests can await it). */
  consentRun: Promise<void> = Promise.resolve();

  private async deliverConsentEmails(actor: SalesActor, leads: any[], ctx: AuditCtx) {
    let sent = 0;
    let failed = 0;
    for (const lead of leads) {
      const id = String(lead._id);
      const ok = await this.email.sendMail(lead.email, 'Can we keep you posted?', this.consentEmail(id, lead.name, lead.businessName)).catch(() => false);
      try {
        if (!ok) {
          failed++;
          await this.leads.updateOne({ _id: id, 'marketingConsent.status': 'asked' }, { $set: { 'marketingConsent.status': 'none', 'marketingConsent.askedAt': null } });
          continue;
        }
        sent++;
        await this.sales.log(id, 'email', 'Asked by email whether they want marketing emails ("Can we keep you posted?").', actor.adminId, { to: lead.email, consent: 'asked' });
      } catch (e) {
        this.logger.warn(`Consent email bookkeeping failed for lead ${id}: ${(e as Error)?.message}`);
      }
    }
    if (leads.length) this.audit(ctx, 'sales.leads.consent_requests', `Sent ${sent} marketing permission email(s), ${failed} failed`, { sent, failed });
  }

  consentEmail(leadId: string, name: string | null, businessName: string | null): string {
    const first = splitName(name).first || 'there';
    const link = `${API_PUBLIC_ORIGIN}/api/sales/consent/${signConsentToken(leadId)}`;
    return solvexoEmail(
      'Can we keep you posted?',
      `<p>Hi ${escapeEmailText(first)}, you were in touch with Solvexo about ${escapeEmailText(businessName?.trim() || 'your business')}. Would you like occasional tips, product news and offers for sellers by email? You can unsubscribe at any time.</p>`,
      { cta: { label: 'Yes, keep me posted', url: link }, note: "If you don't click, we won't add you to our mailing list." },
    );
  }

  // ── Public: the "Yes, keep me posted" link and Brevo's webhook ────────────

  /** Where to send the browser after the confirmation link: `…/email-preferences/confirmed?status=ok|invalid`. */
  async confirmConsent(token: string, ip: string | null): Promise<string> {
    const target = (st: 'ok' | 'invalid') => `${siteUrl()}/email-preferences/confirmed?status=${st}`;
    const claims = verifyConsentToken(token);
    if (!claims) return target('invalid');
    const lead: any = await this.leads.findOne({ _id: claims.leadId, isDelete: false }).select('email marketingConsent').lean();
    if (!lead?.email) return target('invalid');
    const c = lead.marketingConsent ?? {};
    if (c.status === 'granted') return target('ok'); // clicked twice
    // An old link must not undo a later "unsubscribe": only a link sent after the withdrawal counts.
    if (c.status === 'withdrawn' && c.at && new Date(c.at) > claims.issuedAt) return target('invalid');
    await this.leads.updateOne({ _id: claims.leadId }, {
      $set: {
        marketingConsent: { status: 'granted', at: new Date(), source: 'email_confirm', note: null, askedAt: c.askedAt ?? null, ip: ip ? String(ip).slice(0, 64) : null },
        'brevo.pending': true,
      },
    });
    await this.sales.log(claims.leadId, 'system', 'Agreed to marketing emails (clicked "Yes, keep me posted" in our email)', null, { consent: 'granted', source: 'email_confirm' });
    return target('ok');
  }

  /** Brevo's marketing webhook. 404 unless the secret in the URL matches (and Brevo is connected). */
  async webhook(secret: string, body: unknown) {
    const s = await this.load();
    if (!s.brevoApiKeyEnc || !s.brevoWebhookSecret || !safeEqual(String(secret ?? ''), s.brevoWebhookSecret)) throw new NotFoundException();
    const events = parseBrevoWebhook(body);
    for (const e of events) {
      const leads: any[] = await this.leads.find({ email: e.email, 'marketingConsent.status': { $ne: 'withdrawn' } }).select('_id marketingConsent').lean();
      for (const lead of leads) {
        await this.leads.updateOne({ _id: lead._id }, {
          $set: {
            marketingConsent: { status: 'withdrawn', at: new Date(), source: 'brevo', note: e.event, askedAt: lead.marketingConsent?.askedAt ?? null, ip: lead.marketingConsent?.ip ?? null },
            'brevo.pending': true, // taken off our list too; the sync never adds a withdrawn lead back
          },
        });
        await this.sales.log(String(lead._id), 'system', WITHDRAW_ACTIVITY[e.event], null, { consent: 'withdrawn', source: 'brevo', event: e.event });
      }
    }
    return { ok: true };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async queueAll(statuses: string[]): Promise<number> {
    const r: any = await this.leads.updateMany({ isDelete: false, ...withEmail, 'marketingConsent.status': { $in: statuses } }, { $set: { 'brevo.pending': true } });
    return Number(r?.matchedCount ?? r?.modifiedCount ?? 0);
  }

  private async saveRun(error: string | null) {
    await this.settings.updateOne({ key: 'default' }, { $set: { brevoLastSyncAt: new Date(), brevoLastError: error } });
  }

  /** Finds a folder / list by name, paging through up to 1,000 of them. */
  private async findByName(path: string, key: 'folders' | 'lists', name: string, apiKey: string): Promise<{ id: number } | null> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.call('GET', `${path}?limit=50&offset=${page * 50}`, apiKey);
      if (!r.ok) throw new BadRequestException(`Couldn't read your Brevo ${key}: ${r.error}`);
      const items: any[] = Array.isArray(r.data?.[key]) ? r.data[key] : [];
      const hit = items.find((x) => String(x?.name ?? '').trim().toLowerCase() === name.toLowerCase());
      if (hit?.id) return { id: Number(hit.id) };
      if (items.length < 50) return null;
    }
    return null;
  }

  private async call(method: 'GET' | 'POST', path: string, apiKey: string, body?: unknown): Promise<BrevoResult> {
    try {
      const res = await this.fetchFn(`${BREVO}${path}`, {
        method,
        headers: { 'api-key': apiKey, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, data, error: brevoErrorText(res.status, data?.message ?? data?.code ?? null, apiKey) };
      return { ok: true, status: res.status, data, error: null };
    } catch (e: any) {
      return { ok: false, status: null, data: null, error: brevoErrorText(null, e?.name === 'TimeoutError' ? 'Brevo did not answer in time' : e?.message ?? 'network error', apiKey) };
    }
  }

  private audit(ctx: AuditCtx, action: string, description: string, metadata: Record<string, unknown> = {}) {
    // ActivityLogService.log never throws (fire-and-forget). The API key is never part of an entry.
    void this.activityLog?.log({
      category: 'admin_audit', action, description,
      actorId: ctx.adminId ?? null, actorName: ctx.adminEmail ?? null, actorRole: 'admin',
      targetType: 'sales_brevo', ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, metadata,
    });
  }

  private async load(): Promise<any> {
    return (await this.settings.findOne({ key: 'default' }).lean()) ?? {};
  }
}
