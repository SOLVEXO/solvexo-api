/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { FormStat, FormStatDocument } from './schemas/form-stat.schema';
import { readAnalyticsSessionId } from '../common/storefront-session.util';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { CreateContactMessageDto } from './dto/create-contact-message.dto';
import { ContactMessageStatus } from './schemas/store-contact-message.schema';
import { EmailService } from '../otp/services/email.service';
import { notificationEmailShell } from '../notifications/templates/notification-email.template';
import { textToParagraphs } from '../notifications/customer-email-template.util';
import { sellerAppUrl } from '../common/app-urls.util';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.util';
import { UploadService } from '../upload/upload.service';
import { assertFileSignature } from '../upload/upload-file-validation';
import { RedisService } from '../redis/redis.service';
import { MerchantWebhooksService } from '../merchant-api/merchant-webhooks.service';
import { NewsletterService } from '../newsletter/newsletter.service';
import { FormUpload, FormUploadDocument } from './schemas/form-upload.schema';
import { StoreFormSettings, StoreFormSettingsDocument } from './schemas/store-form-settings.schema';
import { detectSpam } from './form-spam.util';
import { testTurnstileSecret, verifyTurnstile } from './turnstile.util';
import { ContactFormField, FILE_EXTENSIONS, MAX_FILE_MB, parseNotifyEmails, resolveContactFields, validateContactAnswers } from './contact-form-fields.util';
import { MAX_EXPORT_ROWS, buildAutoReply, buildSellerNotification, contactMessagesToCsv } from './contact-form-mail.util';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// A store can only answer so fast: stops the inbox being used to push mail out.
const REPLY_WINDOW_MS = 60_000;
const REPLY_MAX_PER_WINDOW = 10;
const MAX_VISITOR_MESSAGES_PER_HOUR = 100;

@Injectable()
export class StoreContactService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    @Optional() @InjectModel(FormUpload.name) private readonly uploads?: Model<FormUploadDocument>,
    @Optional() @InjectModel(StoreFormSettings.name) private readonly formSettings?: Model<StoreFormSettingsDocument>,
    @Optional() private readonly uploadService?: UploadService,
    @Optional() private readonly webhooks?: MerchantWebhooksService,
    @Optional() private readonly newsletter?: NewsletterService,
    @Optional() private readonly redis?: RedisService,
    @Optional() @InjectModel(FormStat.name) private readonly stats?: Model<FormStatDocument>,
  ) {}

  private static readonly replyTimes = new Map<string, number[]>();

  private get model() { return this.databaseService.repositories.storeContactMessageModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  // ── Public ───────────────────────────────────────────────────────────────

  async submit(storeId: string, dto: CreateContactMessageDto, ip?: string) {
    const OK = { success: true, message: 'Thanks — your message was sent.' };
    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name sellerId status').lean();
    if (!store) throw new NotFoundException('Store not found');

    // A flood into one store's inbox (bots that fill the honeypot-free fields) stops here.
    const recent = await this.model.countDocuments({ storeId, status: { $ne: 'spam' }, createdAt: { $gte: new Date(Date.now() - 3_600_000) } });
    if (recent >= MAX_VISITOR_MESSAGES_PER_HOUR) return OK;

    // Honeypot: a filled hidden field means a bot. It is kept in the Spam tab (a few per day) instead of being thrown away silently.
    if (dto.website && dto.website.trim()) {
      await this.keepSpam(storeId, dto, 'honeypot');
      return OK;
    }

    let name = '', email = '', phone = '', message = '';
    let fields: { id: string; label: string; type: string; value: string; fileId?: string }[] = [];
    let formSettings: Record<string, any> = {};
    let defs: ContactFormField[] = [];
    if (dto.sectionId) {
      // The seller's own field list decides what is accepted, never what the visitor's browser claims.
      const form = await this.findForm(storeId, dto.sectionId);
      if (!form) throw new BadRequestException('This form is no longer available. Please reload the page and try again.');
      formSettings = form.settings;
      defs = form.fields;
      const r = validateContactAnswers(form.fields, dto.answers);
      ({ name, email, phone, message } = r);
      fields = r.clean;
      await this.checkCaptcha(storeId, formSettings, dto.captchaToken, ip);
    } else {
      // Older storefront builds send the fixed Name / Email / Phone / Message form.
      name = String(dto.name ?? '').trim(); email = String(dto.email ?? '').trim(); phone = String(dto.phone ?? '').trim(); message = String(dto.message ?? '').trim();
      if (!name) throw new BadRequestException('Your name is required');
      if (!email) throw new BadRequestException('Enter a valid email address');
      if (!message) throw new BadRequestException('Please write a message');
    }

    const claimed = await this.claimUploads(storeId, fields);
    const spam = detectSpam(fields.filter(f => f.type !== 'file' && f.type !== 'signature').map(f => f.value).concat(message), undefined);
    const formName = String(formSettings.formName ?? '').trim().slice(0, 60);
    let doc: any;
    try {
      doc = await this.model.create({
        storeId, name, email, phone: phone || null, message, fields, formName, sectionId: dto.sectionId ?? '',
        ...(await this.enrich(storeId, dto, email)),
        ...(spam ? { status: 'spam', spamReason: spam } : {}),
      });
    } catch (e) {
      await this.releaseUploads(claimed);
      throw e;
    }
    await this.finishUploads(claimed, String(doc._id), spam ? new Date(Date.now() + 30 * 86_400_000) : null);
    if (spam) return OK; // no bell, no emails, no automatic reply, no webhook for spam

    // Tell the owner (in-app bell + email, per their notification preferences). Never fails the visitor's request.
    const who = name || email || phone || 'a visitor';
    const summary = message || fields.slice(0, 3).map(f => `${f.label}: ${f.value}`).join(' · ');
    this.notificationsService.notify({
      recipientId: String(store.sellerId),
      recipientRole: 'seller',
      storeId,
      type: NOTIFICATION_TYPES.CONTACT_FORM_MESSAGE,
      title: formName ? `${formName}: new message from ${who}` : `New message from ${who}`,
      body: summary.length > 160 ? `${summary.slice(0, 157)}…` : summary,
      data: { link: `/store/${storeId}/online-store/contact-messages`, messageId: String(doc._id) },
    }).catch(() => undefined);

    // Emails after the visitor's answer is safely stored: a mail problem never fails the visitor's request.
    this.sendFormEmails(storeId, store, doc, formSettings, { who, formName, fields, name, email, message, phone }).catch(() => undefined);

    // The seller's own systems (Zapier, Make, a CRM) hear about it through the store's webhooks (Webhooks & API).
    this.webhooks?.emit(storeId, 'form.submitted', {
      message_id: String(doc._id), form_name: formName, name, email, phone,
      message, fields: fields.map(f => ({ label: f.label, type: f.type, value: f.value })), submitted_at: new Date().toISOString(),
    }, `form.submitted:${doc._id}`).catch(() => undefined);

    // A ticked consent box that is wired to email marketing signs the visitor up (the newsletter keeps the consent record and the double opt-in rules).
    if (email && defs.some(d => d.subscribes && d.type === 'consent' && fields.some(f => f.id === d.id))) {
      this.newsletter?.subscribe(email, { storeId, source: 'contact_form' }).catch(() => undefined);
    }
    return OK;
  }

  /** Spam kept for the seller to check (capped per store per day, so a bot cannot fill the database either). */
  private async keepSpam(storeId: string, dto: CreateContactMessageDto, reason: string) {
    try {
      const today = await this.model.countDocuments({ storeId, status: 'spam', createdAt: { $gte: new Date(Date.now() - 86_400_000) } });
      if (today >= 100) return;
      const answers = Array.isArray(dto.answers) ? dto.answers.slice(0, 10) : [];
      await this.model.create({
        storeId, status: 'spam', spamReason: reason, sectionId: dto.sectionId ?? '',
        name: String(dto.name ?? '').slice(0, 80), email: String(dto.email ?? '').slice(0, 120), message: String(dto.message ?? '').slice(0, 600),
        fields: answers.map((a: any) => ({ id: String(a?.fieldId ?? '').slice(0, 40), label: String(a?.fieldId ?? '').slice(0, 60), type: 'text', value: String(Array.isArray(a?.value) ? a.value.join(', ') : a?.value ?? '').slice(0, 300) })),
      });
    } catch { /* spam is best effort */ }
  }

  /** The form's CAPTCHA, when the seller switched it on and connected their Cloudflare Turnstile keys. */
  private async checkCaptcha(storeId: string, settings: Record<string, any>, token: string | undefined, ip?: string) {
    if (settings.captcha !== true || !this.formSettings) return;
    const row: any = await this.formSettings.findOne({ storeId }).select('turnstileSiteKey +turnstileSecretEnc').lean();
    if (!row?.turnstileSiteKey || !row?.turnstileSecretEnc) return; // switched on but no keys yet: the form keeps working
    let secret = '';
    try { secret = decryptCredential(row.turnstileSecretEnc, 'INTEGRATIONS'); } catch { return; }
    const r = await verifyTurnstile(secret, token, ip);
    if (r.ok) return;
    if (r.reason === 'unreachable') throw new BadRequestException('We could not check that you are human right now. Please try again in a moment.');
    throw new BadRequestException('Please confirm you are not a robot, then send the form again.');
  }

  // ── Files a visitor attaches ─────────────────────────────────────────────

  /** Stores one file in PRIVATE storage and hands back an id; the file only joins a message when the form is sent. */
  async upload(storeId: string, body: { sectionId?: string; fieldId?: string }, file: any) {
    if (!this.uploads || !this.uploadService) throw new BadRequestException('Uploads are not available');
    if (!file?.buffer) throw new BadRequestException('Choose a file first');
    if (!body.sectionId || !body.fieldId) throw new BadRequestException('This form is no longer available. Please reload the page.');
    const form = await this.findForm(storeId, String(body.sectionId));
    if (!form) throw new BadRequestException('This form is no longer available. Please reload the page.');
    const def = form.fields.find(f => f.id === body.fieldId && (f.type === 'file' || f.type === 'signature'));
    if (!def) throw new BadRequestException('This field does not take a file.');
    const name = String(file.originalname ?? 'file').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
    const ext = (name.split('.').pop() ?? '').toLowerCase();
    const allowed = FILE_EXTENSIONS[def.type === 'signature' ? 'images' : (def.fileKinds ?? 'both')];
    if (!allowed.includes(ext)) throw new BadRequestException(`This type of file is not accepted. Use: ${allowed.join(', ')}`);
    const maxMb = Math.min(def.maxSizeMb ?? MAX_FILE_MB, MAX_FILE_MB);
    if (file.size > maxMb * 1024 * 1024) throw new BadRequestException(`The file is larger than ${maxMb} MB`);
    assertFileSignature({ originalname: name, mimetype: file.mimetype, buffer: file.buffer, size: file.size }); // the bytes must really be that type
    const waiting = await this.uploads.countDocuments({ storeId, claimedBy: null, createdAt: { $gte: new Date(Date.now() - 86_400_000) } });
    if (waiting >= 50) throw new BadRequestException('Too many files are waiting for this store. Please try again later.');
    const up = await this.uploadService.uploadPrivateFile({ ...file, originalname: name }, `private/form-uploads/${storeId}`);
    const doc: any = await this.uploads.create({ storeId, publicId: up.publicId, resourceType: up.resourceType, fileName: name, size: up.fileSize, mimeType: up.mimeType });
    return { success: true, data: { uploadId: String(doc._id), name, size: doc.size } };
  }

  /** Marks the files named in the answers as taken by THIS send, and swaps the id for a readable value. Throws when one expired or was used. */
  private async claimUploads(storeId: string, fields: { id: string; label: string; type: string; value: string; fileId?: string }[]): Promise<string[]> {
    const claimed: string[] = [];
    for (const f of fields) {
      if (f.type !== 'file' && f.type !== 'signature') continue;
      const up: any = this.uploads ? await this.uploads.findOneAndUpdate({ _id: f.value, storeId, claimedBy: null }, { $set: { claimedBy: 'pending' } }, { new: true }).lean() : null;
      if (!up) {
        await this.releaseUploads(claimed);
        throw new BadRequestException('A file you attached has expired. Please attach it again.');
      }
      claimed.push(String(up._id));
      f.fileId = String(up._id);
      f.value = `${up.fileName} (${up.size < 1024 * 1024 ? `${Math.max(1, Math.round(up.size / 1024))} KB` : `${(up.size / 1024 / 1024).toFixed(1)} MB`})`;
    }
    return claimed;
  }

  private async releaseUploads(ids: string[]) {
    if (ids.length && this.uploads) await this.uploads.updateMany({ _id: { $in: ids }, claimedBy: 'pending' }, { $set: { claimedBy: null } }).catch(() => undefined);
  }

  private async finishUploads(ids: string[], messageId: string, expiresAt: Date | null) {
    if (ids.length && this.uploads) await this.uploads.updateMany({ _id: { $in: ids } }, { $set: { claimedBy: messageId, expiresAt } }).catch(() => undefined);
  }

  /** A 2-minute link to one attached file, for the store owner (and staff who may read the inbox) only. */
  async fileLink(storeId: string, sellerId: string, messageId: string, fileId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const msg: any = await this.model.findOne({ _id: messageId, storeId }).select('fields').lean();
    if (!msg || !(msg.fields ?? []).some((f: any) => f.fileId === fileId)) throw new NotFoundException('File not found');
    const up: any = await this.uploads?.findOne({ _id: fileId, storeId }).lean();
    if (!up || !this.uploadService) throw new NotFoundException('The file was removed');
    return { success: true, data: { url: this.uploadService.generateExpiringPrivateUrl(up.publicId, up.resourceType, 120, { fileName: up.fileName }), fileName: up.fileName } };
  }

  /** Nightly: files nobody sent within a day, and the files of spam that has expired. */
  @Cron('40 3 * * *')
  async nightlyCleanup() {
    if (!this.redis || !this.uploads) return;
    await this.redis.withLock('cron-lock:contact-uploads', 300_000, async () => { await this.cleanupUploads(); });
  }

  async cleanupUploads(now = new Date()) {
    if (!this.uploads || !this.uploadService) return 0;
    const old = new Date(now.getTime() - 86_400_000);
    const rows: any[] = await this.uploads.find({ $or: [{ claimedBy: { $in: [null, 'pending'] }, createdAt: { $lt: old } }, { expiresAt: { $lt: now } }] }).limit(200).lean();
    for (const u of rows) {
      await this.uploadService.deletePrivateFile(u.publicId, u.resourceType).catch(() => undefined);
    }
    if (rows.length) await this.uploads.deleteMany({ _id: { $in: rows.map(r => r._id) } });
    return rows.length;
  }

  // ── CAPTCHA settings (the seller's own Cloudflare Turnstile keys) ────────

  /** Is a Turnstile site key set for this store? Public: the visitor's browser needs the site key to draw the widget. */
  async publicConfig(storeId: string) {
    const row: any = await this.formSettings?.findOne({ storeId }).select('turnstileSiteKey').lean();
    return { success: true, data: { captcha: row?.turnstileSiteKey ? { provider: 'turnstile', siteKey: row.turnstileSiteKey } : null } };
  }

  /** Page, traffic source and customer link of a new message. Never fails the visitor's request. */
  private async enrich(storeId: string, dto: { analyticsSessionId?: string; pageUrl?: string }, email: string) {
    const out: { pageUrl: string | null; source: Record<string, string | null> | null; customerId: string | null; customerOrders: number } = { pageUrl: null, source: null, customerId: null, customerOrders: 0 };
    try {
      const url = String(dto.pageUrl ?? '').trim();
      if (/^https?:\/\//i.test(url)) out.pageUrl = url.slice(0, 500);
      const sid = readAnalyticsSessionId(dto);
      if (sid) {
        const row: any = await this.databaseService.repositories.storefrontSessionModel.findOne({ storeId, sessionId: sid })
          .select('trafficSource referrerHost landingPath utmSource utmMedium utmCampaign deviceType country').lean();
        if (row) out.source = { trafficSource: row.trafficSource ?? null, referrerHost: row.referrerHost ?? null, landingPath: row.landingPath ?? null, utmSource: row.utmSource ?? null, utmMedium: row.utmMedium ?? null, utmCampaign: row.utmCampaign ?? null, deviceType: row.deviceType ?? null, country: row.country ?? null };
      }
      if (email) {
        const user: any = await this.databaseService.repositories.userModel.findOne({ storeId, email: email.toLowerCase() }).select('_id').lean();
        if (user) {
          out.customerId = String(user._id);
          out.customerOrders = await this.databaseService.repositories.orderModel.countDocuments({ userId: String(user._id), 'sellerOrders.storeId': storeId });
        }
      }
    } catch { /* optional extras */ }
    return out;
  }

  async getSpamSettings(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const row: any = await this.formSettings?.findOne({ storeId }).select('turnstileSiteKey +turnstileSecretEnc').lean();
    return { success: true, data: { turnstile: { configured: !!(row?.turnstileSiteKey && row?.turnstileSecretEnc), siteKey: row?.turnstileSiteKey ?? '' } } };
  }

  async saveSpamSettings(storeId: string, sellerId: string, body: { siteKey?: string; secretKey?: string }) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const siteKey = String(body.siteKey ?? '').trim();
    const secretKey = String(body.secretKey ?? '').trim();
    if (!/^[0-9A-Za-z_-]{10,80}$/.test(siteKey)) throw new BadRequestException('Paste the Site Key from your Cloudflare Turnstile widget');
    if (secretKey.length < 10 || secretKey.length > 120) throw new BadRequestException('Paste the Secret Key from your Cloudflare Turnstile widget');
    const check = await testTurnstileSecret(secretKey);
    if (check === 'bad_secret') throw new BadRequestException('Cloudflare did not accept this Secret Key. Check it and try again.');
    if (check === 'unreachable') throw new BadRequestException('We could not reach Cloudflare to check the keys. Try again in a moment.');
    await this.formSettings!.updateOne({ storeId }, { $set: { turnstileSiteKey: siteKey, turnstileSecretEnc: encryptCredential(secretKey, 'INTEGRATIONS') } }, { upsert: true });
    return { success: true, data: { turnstile: { configured: true, siteKey } } };
  }

  async clearSpamSettings(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    await this.formSettings?.updateOne({ storeId }, { $set: { turnstileSiteKey: null, turnstileSecretEnc: null } });
    return { success: true, data: { turnstile: { configured: false, siteKey: '' } } };
  }

  /** Email with every answer to the addresses the seller listed, and the automatic reply to the visitor (once a day per address). */
  private async sendFormEmails(
    storeId: string, store: any, doc: any, settings: Record<string, any>,
    d: { who: string; formName: string; fields: { label: string; value: string }[]; name: string; email: string; message: string; phone: string },
  ) {
    const full: any = await this.storeModel.findById(storeId).select('name logo contactEmail').lean();
    const storeName = String(full?.name ?? store?.name ?? 'the store');
    const recipients = parseNotifyEmails(settings.notifyEmails);
    if (recipients.length) {
      const rows = d.fields.length ? d.fields : [{ label: 'Name', value: d.name }, { label: 'Email', value: d.email }, { label: 'Message', value: d.message }].filter(r => r.value);
      const mail = buildSellerNotification({ storeName, logoUrl: full?.logo ?? null, formName: d.formName, who: d.who, rows, inboxUrl: `${sellerAppUrl()}/store/${storeId}/online-store/contact-messages` });
      for (const to of recipients) {
        await this.emailService.sendMail(to, mail.subject, mail.html, d.email || null, undefined, undefined, storeName, storeId).catch(() => false);
      }
    }
    if (settings.autoReplyEnabled === true && d.email) {
      // A form must not be a way to mail strangers: one automatic reply per address per day, per store.
      const already = await this.model.countDocuments({ storeId, email: d.email, autoRepliedAt: { $gte: new Date(Date.now() - 86_400_000) } });
      if (already === 0) {
        const mail = buildAutoReply({ storeName, logoUrl: full?.logo ?? null, formName: d.formName, name: d.name, subject: settings.autoReplySubject, body: settings.autoReplyBody });
        const ok = await this.emailService.sendMail(d.email, mail.subject, mail.html, full?.contactEmail ?? null, undefined, undefined, storeName, storeId).catch(() => false);
        if (ok) await this.model.updateOne({ _id: doc._id }, { $set: { autoRepliedAt: new Date() } });
      }
    }
  }

  /** The live field list and settings of one contact form (any page or template section), or null when that section is gone. */
  private async findForm(storeId: string, sectionId: string): Promise<{ fields: ContactFormField[]; settings: Record<string, any> } | null> {
    const pick = (sections?: any[]) => {
      const sec = (sections ?? []).find(x => String(x?._id) === sectionId && x.type === 'contact_form' && x.enabled !== false);
      return sec ? { fields: resolveContactFields(sec.settings), settings: (sec.settings ?? {}) as Record<string, any> } : null;
    };
    const repos: any = this.databaseService.repositories;
    // A page keeps its live sections per installed theme (themeTemplates[].sections); the root `sections` is the older copy.
    const page: any = await repos.storePageModel
      .findOne({ storeId, isDelete: false, $or: [{ 'sections._id': sectionId }, { 'themeTemplates.sections._id': sectionId }] })
      .select('sections themeTemplates.sections').lean();
    if (page) {
      const fromPage = pick(page.sections) ?? (page.themeTemplates ?? []).map((t: any) => pick(t?.sections)).find(Boolean) ?? null;
      if (fromPage) return fromPage;
    }
    const tpl: any = await repos.collectionTemplateModel.findOne({ storeId, 'sections._id': sectionId }).select('sections').lean();
    return tpl ? pick(tpl.sections) : null;
  }

  // ── Seller ───────────────────────────────────────────────────────────────

  /** The filter shared by the inbox list and the CSV export: status, one form, and a text search. */
  private buildFilter(storeId: string, query: { status?: string; form?: string; q?: string; source?: string }) {
    const filter: Record<string, any> = { storeId };
    if (typeof query.source === 'string' && /^[a-z_]{1,20}$/.test(query.source)) filter['source.trafficSource'] = query.source;
    if (query.status === 'new' || query.status === 'read' || query.status === 'archived' || query.status === 'spam') filter.status = query.status;
    else filter.status = { $ne: 'spam' }; // spam only shows in its own tab
    if (query.form === '__unnamed') filter.formName = '';
    else if (typeof query.form === 'string' && query.form.trim()) filter.formName = query.form.trim().slice(0, 60);
    const q = typeof query.q === 'string' ? query.q.trim().slice(0, 80) : '';
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { message: rx }, { 'fields.value': rx }];
    }
    return filter;
  }

  /** The forms that received messages (for the inbox filter), with their counts. */
  /** A visitor saw the form / started filling it. Anonymous daily counters, only for forms that exist. */
  async trackEvent(storeId: string, sectionId: string, kind: string, fieldId?: string) {
    if (!/^[a-f0-9]{24}$/i.test(sectionId ?? '') || (kind !== 'view' && kind !== 'start' && kind !== 'field') || !this.stats) return { success: true };
    if (kind === 'field' && !/^[A-Za-z0-9_-]{2,40}$/.test(fieldId ?? '')) return { success: true };
    const found = await this.storeModel.exists({ _id: storeId, isDelete: { $ne: true } }).catch(() => null);
    if (!found) return { success: true };
    const day = new Date().toISOString().slice(0, 10);
    await this.stats.updateOne({ storeId, sectionId, day }, { $inc: kind === 'view' ? { views: 1 } : kind === 'start' ? { starts: 1 } : { [`fields.${fieldId}`]: 1 } }, { upsert: true }).catch(() => undefined);
    return { success: true };
  }

  /** Per form, last N days: seen, started, sent, spam, and where the messages came from. */
  async report(storeId: string, sellerId: string, daysRaw?: number) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const days = Math.min(365, Math.max(1, Number(daysRaw) || 30));
    const since = new Date(Date.now() - days * 86_400_000);
    const sinceDay = since.toISOString().slice(0, 10);
    const [msgs, stats]: [any[], any[]] = await Promise.all([
      this.model.aggregate([
        { $match: { storeId, createdAt: { $gte: since } } },
        { $group: { _id: { s: '$sectionId', src: { $ifNull: ['$source.trafficSource', 'unknown'] }, spam: { $eq: ['$status', 'spam'] } }, n: { $sum: 1 }, name: { $last: '$formName' } } },
      ]),
      this.stats ? this.stats.find({ storeId, day: { $gte: sinceDay } }).limit(5000).lean() : Promise.resolve([]),
    ]);
    const dailyMsgs: any[] = await this.model.aggregate([
      { $match: { storeId, status: { $ne: 'spam' }, createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    ]);
    const forms = new Map<string, { sectionId: string; name: string; views: number; starts: number; sent: number; spam: number; sources: Record<string, number>; fieldTouches: Record<string, number> }>();
    const daily = new Map<string, { day: string; views: number; sent: number }>();
    const dayRow = (d: string) => { let r = daily.get(d); if (!r) { r = { day: d, views: 0, sent: 0 }; daily.set(d, r); } return r; };
    const get = (id: string) => { let f = forms.get(id); if (!f) { f = { sectionId: id, name: '', views: 0, starts: 0, sent: 0, spam: 0, sources: {}, fieldTouches: {} }; forms.set(id, f); } return f; };
    for (const m of msgs) {
      const f = get(m._id.s || '');
      if (m.name) f.name = m.name;
      if (m._id.spam) f.spam += m.n; else { f.sent += m.n; f.sources[m._id.src] = (f.sources[m._id.src] ?? 0) + m.n; }
    }
    for (const st of stats) {
      const f = get(String(st.sectionId));
      f.views += st.views ?? 0; f.starts += st.starts ?? 0;
      dayRow(st.day).views += st.views ?? 0;
      for (const [k, n] of Object.entries((st.fields ?? {}) as Record<string, number>)) f.fieldTouches[k] = (f.fieldTouches[k] ?? 0) + Number(n);
    }
    for (const d of dailyMsgs) dayRow(String(d._id)).sent += d.n;
    return { success: true, data: { days, forms: [...forms.values()].sort((a, b) => b.sent - a.sent || b.views - a.views).slice(0, 50), daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)) } };
  }

  async forms(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const rows: any[] = await this.model.aggregate([
      { $match: { storeId, status: { $ne: 'spam' } } },
      { $group: { _id: '$formName', total: { $sum: 1 }, unread: { $sum: { $cond: [{ $eq: ['$status', 'new'] }, 1, 0] } } } },
      { $sort: { total: -1 } },
      { $limit: 50 },
    ]);
    return { success: true, data: rows.map(r => ({ name: r._id || '', total: r.total, unread: r.unread })) };
  }

  /** Every matching message as CSV (newest first, up to 5000). */
  async exportCsv(storeId: string, sellerId: string, query: { status?: string; form?: string; q?: string; source?: string }) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const rows = await this.model.find(this.buildFilter(storeId, query)).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean();
    return contactMessagesToCsv(rows);
  }

  async list(storeId: string, sellerId: string, query: { page?: number; limit?: number; status?: string; form?: string; q?: string; source?: string }) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const page = Math.max(1, Number(query.page) || 1);
    const filter = this.buildFilter(storeId, query);
    const [data, total, unread, spam] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
      this.model.countDocuments({ storeId, status: 'new' }),
      this.model.countDocuments({ storeId, status: 'spam' }),
    ]);
    return { success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, unread, spam };
  }

  async setStatus(storeId: string, sellerId: string, id: string, status: ContactMessageStatus) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const updated = await this.model.findOneAndUpdate({ _id: id, storeId }, { $set: { status, ...(status === 'spam' ? {} : { spamReason: null }) } }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Message not found');
    // Spam is deleted after 30 days, and so are its files; a message rescued from spam keeps them.
    await this.uploads?.updateMany({ claimedBy: String(id) }, { $set: { expiresAt: status === 'spam' ? new Date(Date.now() + 30 * 86_400_000) : null } }).catch(() => undefined);
    return { success: true, data: updated };
  }

  async reply(storeId: string, sellerId: string, id: string, message: string, sentBy: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const text = String(message ?? '').trim();
    if (!text) throw new BadRequestException('Write your reply');
    const now = Date.now();
    const times = (StoreContactService.replyTimes.get(storeId) ?? []).filter(t => now - t < REPLY_WINDOW_MS);
    if (times.length >= REPLY_MAX_PER_WINDOW) throw new BadRequestException('You are sending replies too fast. Wait a minute and try again.');

    const msg: any = await this.model.findOne({ _id: id, storeId }).lean();
    if (!msg) throw new NotFoundException('Message not found');
    if (!msg.email) throw new BadRequestException('This visitor did not leave an email address, so you cannot reply from here.');
    const store: any = await this.storeModel.findById(storeId).select('name logo contactEmail').lean();
    const storeName = String(store?.name ?? 'the store');
    const quoted = `<blockquote style="margin:16px 0 0;padding:8px 12px;border-left:3px solid #ddd;color:#666;font-size:13px;">${textToParagraphs(String(msg.message || (msg.fields ?? []).map((f: any) => `${f.label}: ${f.value}`).join(String.fromCharCode(10))))}</blockquote>`;
    const html = notificationEmailShell(escapeHtml(`Re: Your message to ${storeName}`), `${textToParagraphs(text)}<p style="color:#888;font-size:12px;margin-top:18px;">Your message:</p>${quoted}`, undefined, { name: storeName, logoUrl: store?.logo ?? null });
    const ok = await this.emailService.sendMail(String(msg.email), `Re: Your message to ${storeName}`, html, store?.contactEmail ?? null, undefined, undefined, storeName, storeId);
    if (!ok) throw new BadRequestException('The reply could not be sent. Check your email settings and try again.');

    times.push(now);
    StoreContactService.replyTimes.set(storeId, times);
    const updated = await this.model.findOneAndUpdate(
      { _id: id, storeId },
      { $push: { replies: { message: text, sentAt: new Date(), sentBy: sentBy.slice(0, 80) } }, ...(msg.status === 'new' ? { $set: { status: 'read' } } : {}) },
      { new: true },
    ).lean();
    return { success: true, data: updated };
  }

  async remove(storeId: string, sellerId: string, id: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const res = await this.model.deleteOne({ _id: id, storeId });
    if (!res.deletedCount) throw new NotFoundException('Message not found');
    const files: any[] = (await this.uploads?.find({ storeId, claimedBy: String(id) }).lean()) ?? [];
    for (const u of files) await this.uploadService?.deletePrivateFile(u.publicId, u.resourceType).catch(() => undefined);
    if (files.length) await this.uploads!.deleteMany({ _id: { $in: files.map(f => f._id) } });
    return { success: true, message: 'Message deleted' };
  }
}
