/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';
import { storePublicUrl } from '../newsletter/marketing-email.util';
import { B2BBuyer, B2BBuyerDocument } from './b2b.schema';
import { receivableOf } from './b2b-order.util';

const DAY = 86_400_000;
/** An invoice due within this many days gets one "due soon" reminder. */
export const REMINDER_DUE_SOON_DAYS = 3;
/** After the due date, a reminder every this many days, at most MAX_OVERDUE_REMINDERS times. */
export const REMINDER_OVERDUE_EVERY_DAYS = 7;
export const MAX_OVERDUE_REMINDERS = 4;
const DEAD = ['cancelled', 'refunded'];

export type ReminderKind = 'due_soon' | 'overdue';

/** Which reminder (if any) an order is due for, given what was already sent. Pure, so the schedule is testable. */
export function nextReminder(
  dueDate: Date | null, outstanding: number, sent: { kind: ReminderKind; at: Date | string }[], now: Date,
): ReminderKind | null {
  if (!dueDate || !(outstanding > 0)) return null;
  const due = new Date(dueDate).getTime();
  if (due >= now.getTime()) {
    const soon = due - now.getTime() <= REMINDER_DUE_SOON_DAYS * DAY;
    return soon && !sent.some((s) => s.kind === 'due_soon') ? 'due_soon' : null;
  }
  const overdue = sent.filter((s) => s.kind === 'overdue');
  if (overdue.length >= MAX_OVERDUE_REMINDERS) return null;
  const last = overdue.length ? Math.max(...overdue.map((s) => new Date(s.at).getTime())) : 0;
  return now.getTime() - last >= REMINDER_OVERDUE_EVERY_DAYS * DAY ? 'overdue' : null;
}

/**
 * Wholesale invoice reminders (email): one "due soon" a few days before the due date, then weekly "overdue" reminders (max 4).
 * Goes to the person who placed the order plus the location admins of that company location. A normal catalog event
 * (\`b2b_invoice_reminder\`), so the seller can switch it off or reword it under Settings -> Notifications.
 */
@Injectable()
export class B2BRemindersService {
  private readonly log = new Logger(B2BRemindersService.name);
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    @InjectModel(B2BBuyer.name) private readonly buyers: Model<B2BBuyerDocument>,
  ) {}

  /** Hourly (minute 40), single instance (Redis lock) like every other cron. */
  @Cron('40 * * * *')
  async cron() {
    const r = await this.redis.withLock('cron-lock:b2b-reminders', 20 * 60_000, async () => {
      const n = await this.sendDue();
      if (n > 0) this.log.log(`B2B invoice reminders sent for ${n} order(s)`);
    });
    if (r === 'lock_not_acquired') this.log.debug('Skipped B2B reminders: another instance holds the lock (or Redis is unavailable)');
  }

  async sendDue(now: Date = new Date(), limit = 300): Promise<number> {
    const { orderModel, userModel, storeModel } = this.db.repositories as any;
    const orders: any[] = await orderModel.find({
      isDelete: false, 'b2b.terms': { $ne: null }, 'b2b.status': { $ne: 'paid' }, orderStatus: { $nin: DEAD }, 'b2b.dueDate': { $ne: null },
      $or: [{ 'b2b.lastReminderAt': null }, { 'b2b.lastReminderAt': { $exists: false } }, { 'b2b.lastReminderAt': { $lt: new Date(now.getTime() - 20 * 3600_000) } }],
    }).select('orderNumber userId currency b2b sellerOrders.storeId orderStatus updatedAt').limit(limit).lean();

    let sent = 0;
    for (const o of orders) {
      try {
        const rec = receivableOf(o, now);
        if (!rec) continue;
        const kind = nextReminder(rec.dueDate ? new Date(rec.dueDate) : null, rec.outstanding, o.b2b.remindersSent ?? [], now);
        if (!kind) continue;
        // Claim first (atomic): two instances / a retry can never send the same reminder twice.
        const claim = await orderModel.updateOne(
          { _id: o._id, $or: [{ 'b2b.lastReminderAt': null }, { 'b2b.lastReminderAt': { $exists: false } }, { 'b2b.lastReminderAt': { $lt: new Date(now.getTime() - 20 * 3600_000) } }] },
          { $set: { 'b2b.lastReminderAt': now }, $push: { 'b2b.remindersSent': { kind, at: now } } },
        );
        if (claim.modifiedCount === 0) continue;
        const storeId = String(o.sellerOrders?.[0]?.storeId ?? '');
        const store: any = await storeModel.findById(storeId).select('slug customDomain customDomainStatus primaryDomain').lean();
        const base = storePublicUrl(store);
        const admins: any[] = await this.buyers.find({ storeId, locationId: o.b2b.locationId, role: 'location_admin', status: 'active' }).select('userId').lean();
        const userIds = [...new Set([String(o.userId), ...admins.map((a) => String(a.userId))])];
        const users: any[] = await userModel.find({ _id: { $in: userIds }, storeId }).select('name email isGuest').lean();
        const url = base ? `${base}/orders/${o._id}` : '';
        for (const u of users) {
          if (!u.email || u.isGuest) continue;
          await this.notifications.sendCustomerEmail({
            to: u.email, storeId, event: 'b2b_invoice_reminder', orderId: String(o._id),
            vars: {
              customerName: u.name ?? '', orderNumber: String(o.orderNumber), orderUrl: url, poNumber: o.b2b.poNumber ?? '—',
              amountDue: `${o.currency} ${rec.outstanding.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
              dueDate: rec.dueDate ? new Date(rec.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '',
              reminderNote: kind === 'overdue' ? 'This invoice is now overdue. Please arrange payment as soon as you can.' : 'This invoice is due soon.',
            },
            ...(url ? { cta: { label: 'View order', url } } : {}),
          });
        }
        sent++;
      } catch (e: any) {
        this.log.warn(`B2B reminder for order ${o?.orderNumber} failed: ${e?.message}`);
      }
    }
    return sent;
  }
}
