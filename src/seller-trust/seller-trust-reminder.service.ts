/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { NotificationsService } from '@/notifications/notifications.service';
import { NOTIFICATION_TYPES } from '@/notifications/notification.types';
import { SellerTrustService } from './seller-trust.service';
import {
  FIRST_REMINDER_DAYS, REMINDABLE_STATUSES, reminderMessage, reminderStage, shouldSendStage,
} from './seller-trust-reminder.util';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STORES_PER_RUN = 5000;

export interface AutoReminderResult { checked: number; sent: number; skipped: number }

/**
 * Daily automatic verification reminders: 14, 7, 3 and 1 days before the deadline, and once when the deadline passes.
 * Each stage goes out ONCE per store per deadline. Nothing is sent while enforcement is off, to verified stores, or to
 * stores that already submitted (they are waiting for Solvexo). A store an admin reminded by hand in the last 24 hours is
 * left for the next run, so a seller never gets two notices in a day.
 */
@Injectable()
export class SellerTrustReminderService {
  private readonly logger = new Logger(SellerTrustReminderService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly sellerTrust: SellerTrustService,
    private readonly notifications: NotificationsService,
  ) {}

  private get storeModel() { return this.db.repositories.storeModel; }

  async sendDueReminders(now = new Date()): Promise<AutoReminderResult> {
    const result: AutoReminderResult = { checked: 0, sent: 0, skipped: 0 };
    const settings = await this.sellerTrust.getSettings();
    if (!settings.enforcementStartedAt) return result; // not enforced: no deadlines, nothing to remind about

    const stores: any[] = await this.storeModel.find({
      isDelete: false,
      status: { $ne: 'suspended' },
      verificationStatus: { $in: [...REMINDABLE_STATUSES, null] },
      verificationDueAt: { $ne: null, $lte: new Date(now.getTime() + FIRST_REMINDER_DAYS * DAY_MS) },
    }).select('name sellerId verificationDueAt lastTrustReminderAt trustAutoReminder').limit(MAX_STORES_PER_RUN).lean();

    for (const store of stores) {
      result.checked++;
      const due = new Date(store.verificationDueAt);
      const stage = reminderStage(due, now);
      if (!stage || !shouldSendStage(stage, store.trustAutoReminder, due)) { result.skipped++; continue; }
      if (store.lastTrustReminderAt && now.getTime() - new Date(store.lastTrustReminderAt).getTime() < DAY_MS) { result.skipped++; continue; }

      // Atomic claim: only the run that still sees the previous value sends (a second instance or a retry finds it changed).
      const prev = store.trustAutoReminder;
      const claim = await this.storeModel.updateOne(
        {
          _id: store._id,
          verificationStatus: { $in: [...REMINDABLE_STATUSES, null] },
          ...(prev?.at ? { 'trustAutoReminder.at': prev.at } : { $or: [{ trustAutoReminder: null }, { trustAutoReminder: { $exists: false } }] }),
        },
        {
          $set: { trustAutoReminder: { stage, forDueAt: due, at: now }, lastTrustReminderAt: now },
          $push: { 'verification.history': { action: 'reminder_auto', note: stage, actorId: null, actorRole: 'admin', at: now } },
        },
      );
      if (!claim?.modifiedCount) { result.skipped++; continue; }

      const { title, body } = reminderMessage(stage, store.name, due);
      await this.notifications.notify({
        recipientId: store.sellerId, recipientRole: 'seller', storeId: String(store._id),
        type: NOTIFICATION_TYPES.VERIFICATION_REMINDER, title, body,
        data: { storeId: String(store._id), link: `/store/${String(store._id)}/settings/verification` },
      }).catch((err: any) => this.logger.warn(`auto reminder for ${store._id} failed: ${err?.message}`));
      result.sent++;
    }
    return result;
  }
}
