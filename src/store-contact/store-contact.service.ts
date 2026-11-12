/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
import { ContactFormField, parseNotifyEmails, resolveContactFields, validateContactAnswers } from './contact-form-fields.util';
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
  ) {}

  private static readonly replyTimes = new Map<string, number[]>();

  private get model() { return this.databaseService.repositories.storeContactMessageModel; }
  private get storeModel() { return this.databaseService.repositories.storeModel; }

  // ── Public ───────────────────────────────────────────────────────────────

  async submit(storeId: string, dto: CreateContactMessageDto) {
    // Honeypot: a filled hidden field means a bot — pretend it worked, store nothing.
    if (dto.website && dto.website.trim()) return { success: true, message: 'Thanks — your message was sent.' };

    const store: any = await this.storeModel.findOne({ _id: storeId, isDelete: false }).select('name sellerId status').lean();
    if (!store) throw new NotFoundException('Store not found');

    // A flood into one store's inbox (bots that fill the honeypot-free fields) stops here.
    const recent = await this.model.countDocuments({ storeId, createdAt: { $gte: new Date(Date.now() - 3_600_000) } });
    if (recent >= MAX_VISITOR_MESSAGES_PER_HOUR) return { success: true, message: 'Thanks — your message was sent.' };

    let name = '', email = '', phone = '', message = '';
    let fields: { id: string; label: string; type: string; value: string }[] = [];
    let formSettings: Record<string, any> = {};
    if (dto.sectionId) {
      // The seller's own field list decides what is accepted, never what the visitor's browser claims.
      const form = await this.findForm(storeId, dto.sectionId);
      if (!form) throw new BadRequestException('This form is no longer available. Please reload the page and try again.');
      formSettings = form.settings;
      const r = validateContactAnswers(form.fields, dto.answers);
      ({ name, email, phone, message } = r);
      fields = r.clean;
    } else {
      // Older storefront builds send the fixed Name / Email / Phone / Message form.
      name = String(dto.name ?? '').trim(); email = String(dto.email ?? '').trim(); phone = String(dto.phone ?? '').trim(); message = String(dto.message ?? '').trim();
      if (!name) throw new BadRequestException('Your name is required');
      if (!email) throw new BadRequestException('Enter a valid email address');
      if (!message) throw new BadRequestException('Please write a message');
    }

    const formName = String(formSettings.formName ?? '').trim().slice(0, 60);
    const doc = await this.model.create({ storeId, name, email, phone: phone || null, message, fields, formName, sectionId: dto.sectionId ?? '' });

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

    return { success: true, message: 'Thanks — your message was sent.' };
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
  private buildFilter(storeId: string, query: { status?: string; form?: string; q?: string }) {
    const filter: Record<string, any> = { storeId };
    if (query.status === 'new' || query.status === 'read' || query.status === 'archived') filter.status = query.status;
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
  async forms(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const rows: any[] = await this.model.aggregate([
      { $match: { storeId } },
      { $group: { _id: '$formName', total: { $sum: 1 }, unread: { $sum: { $cond: [{ $eq: ['$status', 'new'] }, 1, 0] } } } },
      { $sort: { total: -1 } },
      { $limit: 50 },
    ]);
    return { success: true, data: rows.map(r => ({ name: r._id || '', total: r.total, unread: r.unread })) };
  }

  /** Every matching message as CSV (newest first, up to 5000). */
  async exportCsv(storeId: string, sellerId: string, query: { status?: string; form?: string; q?: string }) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const rows = await this.model.find(this.buildFilter(storeId, query)).sort({ createdAt: -1 }).limit(MAX_EXPORT_ROWS).lean();
    return contactMessagesToCsv(rows);
  }

  async list(storeId: string, sellerId: string, query: { page?: number; limit?: number; status?: string; form?: string; q?: string }) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const page = Math.max(1, Number(query.page) || 1);
    const filter = this.buildFilter(storeId, query);
    const [data, total, unread] = await Promise.all([
      this.model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(filter),
      this.model.countDocuments({ storeId, status: 'new' }),
    ]);
    return { success: true, data, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) }, unread };
  }

  async setStatus(storeId: string, sellerId: string, id: string, status: ContactMessageStatus) {
    await verifyStoreOwnershipStrict(this.storeModel, storeId, sellerId);
    const updated = await this.model.findOneAndUpdate({ _id: id, storeId }, { $set: { status } }, { new: true }).lean();
    if (!updated) throw new NotFoundException('Message not found');
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
    return { success: true, message: 'Message deleted' };
  }
}
