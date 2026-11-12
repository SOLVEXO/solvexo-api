/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { pageOf } from '../common/paging';
import { MessagingConsent, MessagingConsentDocument } from './messaging.schema';
import { Channel, CHANNELS, contactKey } from './messaging-rules.util';

export const OPT_IN_SOURCES = ['checkout', 'storefront', 'manual', 'import'] as const;
const clean = (v: any, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/**
 * Per-store, per-channel messaging consent. WhatsApp and SMS are separate from email consent and from each other.
 * An opt-out is recorded at once, always wins over an opt-in that arrives without a newer explicit action, and every
 * change keeps a history line (source + time).
 */
@Injectable()
export class MessagingConsentService {
  constructor(@InjectModel(MessagingConsent.name) private readonly model: Model<MessagingConsentDocument>) {}

  private channel(c: any): Channel {
    if (!(CHANNELS as readonly string[]).includes(c)) throw new BadRequestException('Unknown channel');
    return c;
  }

  /** Explicit opt-in (the person agreed, source says how). Re-opting in after a STOP is allowed: it is a new explicit action. */
  async optIn(storeId: string, channel: Channel, phone: unknown, opts: { source: string; customerId?: string | null; name?: string | null }) {
    this.channel(channel);
    const key = contactKey(phone);
    if (!key) throw new BadRequestException('Enter a valid phone number');
    if (!(OPT_IN_SOURCES as readonly string[]).includes(opts.source)) throw new BadRequestException('Unknown opt-in source');
    const now = new Date();
    await this.model.updateOne(
      { storeId, channel, contactKey: key },
      {
        $set: { status: 'opted_in', optInSource: opts.source, optedInAt: now, ...(opts.customerId ? { customerId: opts.customerId } : {}), ...(clean(opts.name, 120) ? { name: clean(opts.name, 120) } : {}) },
        $push: { history: { $each: [{ status: 'opted_in', at: now, source: opts.source }], $slice: -20 } },
      },
      { upsert: true },
    );
    return { contactKey: key };
  }

  /** Withdraws consent immediately (STOP reply, seller action, unsubscribe link). Works even if the person was never on the list. */
  async optOut(storeId: string, channel: Channel, phone: unknown, source: string) {
    this.channel(channel);
    const key = contactKey(phone);
    if (!key) return { contactKey: null };
    const now = new Date();
    await this.model.updateOne(
      { storeId, channel, contactKey: key },
      { $set: { status: 'opted_out', optedOutAt: now, optOutSource: clean(source, 40) ?? 'unknown' }, $push: { history: { $each: [{ status: 'opted_out', at: now, source: clean(source, 40) ?? 'unknown' }], $slice: -20 } } },
      { upsert: true },
    );
    return { contactKey: key };
  }

  /** Bulk opt-in from a list the seller collected themselves. The seller must attest that every person agreed (recorded as source "import"). */
  async importOptIns(storeId: string, channel: Channel, rows: { phone?: unknown; name?: unknown }[], attested: unknown) {
    if (attested !== true) throw new BadRequestException('Confirm that every person on this list agreed to receive these messages');
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > 5000) throw new BadRequestException('Send between 1 and 5000 contacts');
    let added = 0; let invalid = 0; let keptOptedOut = 0;
    for (const r of rows) {
      const key = contactKey(r?.phone);
      if (!key) { invalid++; continue; }
      const existing: any = await this.model.findOne({ storeId, channel, contactKey: key }).select('status').lean();
      // An import must never silently re-subscribe someone who sent STOP: they have to opt in themselves again.
      if (existing?.status === 'opted_out') { keptOptedOut++; continue; }
      await this.optIn(storeId, channel, r.phone, { source: 'import', name: clean(r.name, 120) });
      added++;
    }
    return { added, invalid, keptOptedOut };
  }

  /** consent rows for keys of THIS store (map by key). */
  async statusFor(storeId: string, channel: Channel, keys: string[]): Promise<Map<string, string>> {
    if (keys.length === 0) return new Map();
    const rows: any[] = await this.model.find({ storeId, channel, contactKey: { $in: keys } }).select('contactKey status').lean();
    return new Map(rows.map((r) => [r.contactKey, r.status]));
  }

  async list(storeId: string, q: { channel?: string; status?: string; page?: any; limit?: any; search?: string }) {
    const { page, limit, skip } = pageOf(q.page, q.limit);
    const filter: any = { storeId, channel: this.channel(q.channel ?? 'whatsapp') };
    if (q.status === 'opted_in' || q.status === 'opted_out') filter.status = q.status;
    if (typeof q.search === 'string' && q.search.trim()) {
      const digits = q.search.replace(/\D/g, '');
      filter.$or = [...(digits ? [{ contactKey: { $regex: digits.slice(0, 15) } }] : []), { name: { $regex: q.search.trim().slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }];
    }
    const [items, total, optedIn, optedOut] = await Promise.all([
      this.model.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
      this.model.countDocuments(filter),
      this.model.countDocuments({ storeId, channel: filter.channel, status: 'opted_in' }),
      this.model.countDocuments({ storeId, channel: filter.channel, status: 'opted_out' }),
    ]);
    return { items, total, page, limit, optedIn, optedOut };
  }
}
