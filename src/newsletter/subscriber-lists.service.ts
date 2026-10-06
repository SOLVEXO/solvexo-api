/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { DatabaseService } from '../database/databaseservice';
import { EmailService } from '../otp/services/email.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NEWSLETTER_BROADCAST_SEND_JOB, QUEUE_NAMES } from '../queues/queue.constants';
import { normalizeEmail, setMarketingConsent } from './newsletter-consent.util';
import { renderMarketingEmail, renderMergeTags, textToHtml } from './marketing-email.util';

import { importSubscribersCsv } from './subscriber-bulk-import';

const APP_NAME = process.env.APP_NAME || 'Solvexo';
const MAX_EXPORT_ROWS = 50_000;

export interface SubscriberListQuery {
  status?: 'active' | 'unsubscribed' | 'pending' | 'all';
  search?: string;
  source?: string;
  page?: string | number;
  limit?: string | number;
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  // Leading =,+,-,@ would be evaluated as a formula by Excel/Sheets.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * Subscriber list management for both kinds of list:
 *  - a store's own list (seller's Customers → Subscribers screen), and
 *  - Solvexo's platform list, storeId null (admin's Newsletter screen),
 * plus the admin's broadcast to the platform list. Consent writes still go
 * through setMarketingConsent so every entry point behaves identically.
 */
@Injectable()
export class SubscriberListsService {
  private readonly logger = new Logger(SubscriberListsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly emailService: EmailService,
    @InjectQueue(QUEUE_NAMES.NEWSLETTER_BROADCASTS) private readonly broadcastQueue: Queue,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  async assertStoreOwner(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, isDelete: false }).select('sellerId name').lean().catch(() => null);
    if (!store) throw new NotFoundException('Store not found');
    if (String((store as any).sellerId) !== String(sellerId)) throw new ForbiddenException('Not your store');
    return store as any;
  }

  private buildFilter(storeId: string | null, query: SubscriberListQuery) {
    const filter: Record<string, any> = { storeId };
    if (query.status === 'active') filter.isActive = true;
    // "Unsubscribed" is a real opt-out — not a double opt-in still awaiting its click.
    else if (query.status === 'unsubscribed') { filter.isActive = false; filter.pendingConfirmation = { $ne: true }; }
    else if (query.status === 'pending') filter.pendingConfirmation = true;
    if (query.source) filter.source = String(query.source);
    if (query.search) {
      const re = new RegExp(String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.email = re;
    }
    return filter;
  }

  async list(storeId: string | null, query: SubscriberListQuery) {
    const model = this.r.newsletterSubscriberModel;
    const page = Math.max(1, parseInt(String(query.page ?? 1)) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? 25)) || 25));
    const filter = this.buildFilter(storeId, query);
    const since = new Date(Date.now() - 30 * 86_400_000);

    const [items, total, active, unsubscribed, newLast30Days, bySource, pending] = await Promise.all([
      model.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
        .select('email isActive pendingConfirmation source consentAt unsubscribedAt userId createdAt').lean(),
      model.countDocuments(filter),
      model.countDocuments({ storeId, isActive: true }),
      model.countDocuments({ storeId, isActive: false, pendingConfirmation: { $ne: true } }),
      model.countDocuments({ storeId, isActive: true, consentAt: { $gte: since } }),
      model.aggregate([{ $match: { storeId, isActive: true } }, { $group: { _id: '$source', count: { $sum: 1 } } }]),
      model.countDocuments({ storeId, pendingConfirmation: true }),
    ]);

    // Resolve linked accounts' names so the list isn't just bare emails.
    const userIds = [...new Set(items.map((i: any) => i.userId).filter(Boolean))];
    const users = userIds.length ? await this.r.userModel.find({ _id: { $in: userIds } }).select('name').lean() : [];
    const nameById = new Map(users.map((u: any) => [String(u._id), u.name]));

    return {
      success: true,
      data: {
        items: items.map((i: any) => ({
          _id: String(i._id),
          email: i.email,
          name: i.userId ? nameById.get(String(i.userId)) ?? null : null,
          status: i.isActive ? 'subscribed' : i.pendingConfirmation ? 'pending' : 'unsubscribed',
          source: i.source,
          consentAt: i.consentAt ?? i.createdAt ?? null,
          unsubscribedAt: i.unsubscribedAt ?? null,
          createdAt: i.createdAt ?? null,
        })),
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        summary: {
          active,
          unsubscribed,
          pending,
          newLast30Days,
          bySource: Object.fromEntries(bySource.map((s: any) => [s._id ?? 'unknown', s.count])),
        },
      },
    };
  }

  async exportCsv(storeId: string | null, query: SubscriberListQuery): Promise<string> {
    const rows = await this.r.newsletterSubscriberModel
      .find(this.buildFilter(storeId, query))
      .sort({ createdAt: -1 })
      .limit(MAX_EXPORT_ROWS)
      .select('email isActive pendingConfirmation source consentAt unsubscribedAt createdAt')
      .lean();
    const header = ['email', 'status', 'source', 'consent_at', 'unsubscribed_at', 'created_at'];
    const lines = rows.map((r: any) => [
      r.email, r.isActive ? 'subscribed' : r.pendingConfirmation ? 'pending_confirmation' : 'unsubscribed', r.source,
      r.consentAt ?? r.createdAt, r.unsubscribedAt ?? '', r.createdAt,
    ].map(csvCell).join(','));
    return [header.join(','), ...lines].join('\n');
  }

  async addOne(storeId: string | null, email: string, source: string) {
    const normalized = normalizeEmail(email);
    if (!isEmail(normalized)) throw new BadRequestException('Invalid email address');
    const existing = await this.r.newsletterSubscriberModel.findOne({ storeId, email: normalized }).lean();
    // Someone who unsubscribed can only opt back in themselves — a seller
    // re-adding them would override their choice (Shopify blocks this too).
    if (existing && !existing.isActive && !existing.pendingConfirmation) {
      throw new BadRequestException('This person unsubscribed. They can only re-subscribe themselves (e.g. from your storefront).');
    }
    const result = await setMarketingConsent(this.r.newsletterSubscriberModel, { storeId, email: normalized, subscribed: true, source });
    return { success: true, message: result.wasActive ? 'Already subscribed' : 'Subscriber added' };
  }

  /** Shared-engine CSV import for a STORE's list (seller-attested consent is
   *  enforced by the controller). Active → skipped, opted-out → skipped
   *  (compliance), pending double opt-in → activated by the attested import. */
  importCsv(storeId: string, text: string, source: string) {
    const model = this.r.newsletterSubscriberModel;
    return importSubscribersCsv(
      {
        getState: async (email) => {
          const row: any = await model.findOne({ storeId: String(storeId), email: String(email) }).select('isActive pendingConfirmation').lean();
          if (!row) return 'none';
          if (row.isActive) return 'active';
          return row.pendingConfirmation ? 'none' : 'unsubscribed';
        },
        subscribe: (email) => setMarketingConsent(model, { storeId, email, subscribed: true, source }),
      },
      text,
    );
  }

  async setStatus(storeId: string | null, subscriberId: string, subscribed: boolean) {
    const row = await this.r.newsletterSubscriberModel.findOne({ _id: subscriberId, storeId }).lean().catch(() => null);
    if (!row) throw new NotFoundException('Subscriber not found');
    if (subscribed && !row.isActive) {
      throw new BadRequestException(row.pendingConfirmation
        ? 'This person has not confirmed their subscription yet. They need to click the link in the confirmation email.'
        : 'This person unsubscribed. They can only re-subscribe themselves.');
    }
    if (!subscribed && row.pendingConfirmation) {
      // Cancels a sign-up that was never confirmed.
      await this.r.newsletterSubscriberModel.updateOne({ _id: row._id }, { $set: { pendingConfirmation: false, confirmToken: null, unsubscribedAt: new Date() } });
      return { success: true, message: 'Unsubscribed' };
    }
    await setMarketingConsent(this.r.newsletterSubscriberModel, { storeId, email: row.email, subscribed, source: row.source });
    if (storeId && !subscribed) {
      const users = await this.r.userModel.find({ email: row.email }).select('_id').lean();
      if (users.length) {
        await this.r.storeCustomerMetaModel.updateMany(
          { storeId, userId: { $in: users.map((u: any) => String(u._id)) } },
          { $set: { marketingOptIn: false } },
        );
      }
    }
    return { success: true, message: subscribed ? 'Subscribed' : 'Unsubscribed' };
  }

  async remove(storeId: string | null, subscriberId: string) {
    const res = await this.r.newsletterSubscriberModel.deleteOne({ _id: subscriberId, storeId }).catch(() => null);
    if (!res?.deletedCount) throw new NotFoundException('Subscriber not found');
    return { success: true, message: 'Subscriber removed' };
  }

  // ── Admin broadcast to the platform list ─────────────────────────────────

  async listBroadcasts() {
    const items = await this.r.newsletterBroadcastModel.find().sort({ createdAt: -1 }).limit(50).lean();
    return { success: true, data: items };
  }

  async broadcast(adminId: string, subject: string, message: string, testEmail?: string) {
    if (!subject?.trim() || !message?.trim()) throw new BadRequestException('Subject and message are required');

    if (testEmail) {
      const sent = await this.emailService.sendMail(
        normalizeEmail(testEmail),
        `[Test] ${subject}`,
        renderMarketingEmail({
          senderName: APP_NAME,
          bodyHtml: textToHtml(renderMergeTags(message, { storeName: APP_NAME, customerName: 'there' })),
          reason: `You're receiving this because you subscribed to ${APP_NAME} updates.`,
          unsubscribeUrl: '#',
        }),
      );
      return { success: sent, message: sent ? `Test email sent to ${testEmail}` : 'Test email failed to send' };
    }

    const recipients = await this.r.newsletterSubscriberModel
      .find({ storeId: null, isActive: true })
      .select('email unsubscribeToken')
      .lean();
    if (recipients.length === 0) throw new BadRequestException('There are no active platform subscribers yet');

    const record = await this.r.newsletterBroadcastModel.create({
      subject, message, createdBy: adminId, status: 'sending', recipientCount: recipients.length,
    });
    // One durable queued job per recipient (NewsletterBroadcastProcessor) —
    // the admin gets an immediate response and the history table's counters
    // fill in; a restart/deploy mid-send doesn't lose the rest.
    await this.broadcastQueue.addBulk((recipients as any[]).map((r) => ({
      name: NEWSLETTER_BROADCAST_SEND_JOB,
      data: { broadcastId: String(record._id), email: r.email, unsubscribeToken: r.unsubscribeToken, subject, message },
    })));
    return { success: true, message: `Sending to ${recipients.length} subscriber(s)`, data: record };
  }
}
