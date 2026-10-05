/* eslint-disable prettier/prettier */
import { Injectable, Logger, ForbiddenException, NotFoundException } from '@nestjs/common';
import { buyerEmail } from '../common/buyer-email.util';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EmailService } from '@/otp/services/email.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { randomBytes } from 'crypto';
import { UpdateAbandonedCartSettingsDto } from './dto/update-abandoned-cart-settings.dto';

import { API_PUBLIC_ORIGIN } from '@/common/api-origin';
const DEFAULT_SETTINGS = { enabled: true, delayMinutes: 60, subject: 'You left something in your cart', message: "Hi {{customerName}}, you still have items waiting in your cart at {{storeName}}. Complete your order before they're gone: {{cartUrl}}" };
const BATCH_SIZE = 200; // max emails sent per cron tick — never let one runaway backlog block the lock for too long
const SCAN_PAGE_SIZE = 200; // checkouts examined per page (newest first)
const MAX_SCAN_PER_TICK = 2000; // hard cap on checkouts examined per tick
const RECOVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // older abandoned checkouts are expired, never emailed

/**
 * Abandoned Cart Recovery — the real end-to-end flow, not just a DB record:
 * a checkout is detected as abandoned by `processAbandonedCarts` (called
 * from SchedulerService's cron), one real email goes out via EmailService,
 * a click on its link is tracked (`trackClick`), and — the moment the buyer
 * actually completes that exact checkout — `markRecovered` (called from
 * PaymentService.createOrder) closes the loop with a real recovered-revenue
 * number a seller can see in `getStats`.
 *
 * A cart can span multiple sellers' stores at once (Solvexo is a
 * marketplace, unlike a single-tenant Shopify store) — see the doc comment
 * on `resolveTriggerSettings` for how that's handled without sending more
 * than one email per abandoned checkout.
 */
@Injectable()
export class AbandonedCartService {
  private readonly logger = new Logger(AbandonedCartService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly emailService: EmailService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  private get r() {
    return this.db.repositories;
  }

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  /** Absence of a settings doc means "enabled with defaults" — see the
   *  schema's own doc comment on why recovery is on by default. */
  private async getOrDefaultSettings(storeId: string) {
    const existing = await this.r.abandonedCartSettingsModel.findOne({ storeId, isDelete: false }).lean();
    return existing ?? { storeId, ...DEFAULT_SETTINGS, _id: null };
  }

  async getSettings(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const settings = await this.getOrDefaultSettings(storeId);
    return { success: true, message: 'Abandoned cart settings', data: settings };
  }

  async updateSettings(sellerId: string, storeId: string, dto: UpdateAbandonedCartSettingsDto) {
    await this.verifyStoreOwnership(storeId, sellerId);
    // Only the explicit "turn it on" case needs a check here — `enabled`
    // being left untouched (including a store that's never called this at
    // all, which is why recovery is on-by-default) is enforced at the real
    // send point instead, in resolveTriggerSettings(), since a plan
    // downgrade after a seller already enabled this must also stop sending.
    if (dto.enabled === true) {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'abandonedCartRecoveryAllowed', 'Abandoned Cart Recovery');
    }
    const settings = await this.r.abandonedCartSettingsModel.findOneAndUpdate(
      { storeId },
      { $set: { storeId, ...dto }, $setOnInsert: DEFAULT_SETTINGS },
      { new: true, upsert: true },
    );
    return { success: true, message: 'Abandoned cart settings updated', data: settings };
  }

  // ── Seller dashboard ──────────────────────────────────────────────────────

  async listAbandoned(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));

    const filter: any = {
      isDelete: false,
      status: { $in: ['pending', 'payment_pending'] },
      'items.storeId': storeId,
    };
    if (query.recoveryStatus === 'sent') filter.abandonedEmailSentAt = { $ne: null };
    if (query.recoveryStatus === 'clicked') filter.abandonedClickedAt = { $ne: null };
    if (query.recoveryStatus === 'recovered') filter.recoveredAt = { $ne: null };
    if (query.recoveryStatus === 'pending') filter.abandonedEmailSentAt = null;

    const [checkouts, total] = await Promise.all([
      this.r.checkoutModel.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.r.checkoutModel.countDocuments(filter),
    ]);

    const userIds = [...new Set(checkouts.map((c: any) => c.userId))];
    const users = await this.r.userModel.find({ _id: { $in: userIds } }).select('name email contactEmail isGuest').lean();
    const userMap = Object.fromEntries(users.map((u: any) => [u._id.toString(), u]));

    const items = checkouts.map((c: any) => {
      const storeItems = c.items.filter((i: any) => i.storeId === storeId);
      return {
        checkoutId: c._id.toString(),
        customerName: userMap[c.userId]?.name ?? 'Unknown',
        customerEmail: buyerEmail(userMap[c.userId]) ?? null,
        itemCount: storeItems.reduce((s: number, i: any) => s + i.quantity, 0),
        cartValue: c.totalAmount,
        currency: c.currency,
        abandonedAt: c.updatedAt,
        recoveryStatus: c.recoveredAt ? 'recovered' : c.abandonedClickedAt ? 'clicked' : c.abandonedEmailSentAt ? 'sent' : 'pending',
      };
    });

    return { success: true, message: 'Abandoned carts', data: { items, total, page, limit } };
  }

  async getStats(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const baseFilter = { isDelete: false, 'items.storeId': storeId };

    const [abandoned, sent, clicked, recoveredDocs] = await Promise.all([
      this.r.checkoutModel.countDocuments({ ...baseFilter, status: { $in: ['pending', 'payment_pending', 'expired'] } }),
      this.r.checkoutModel.countDocuments({ ...baseFilter, abandonedEmailSentAt: { $ne: null } }),
      this.r.checkoutModel.countDocuments({ ...baseFilter, abandonedClickedAt: { $ne: null } }),
      this.r.checkoutModel.find({ ...baseFilter, recoveredAt: { $ne: null } }).select('totalAmount').lean(),
    ]);

    const recoveredRevenue = recoveredDocs.reduce((s: number, c: any) => s + (c.totalAmount || 0), 0);

    return {
      success: true,
      data: { abandonedCount: abandoned, emailsSent: sent, clicked, recovered: recoveredDocs.length, recoveredRevenue },
    };
  }

  // ── The recovery loop itself ─────────────────────────────────────────────

  /** Which store's settings govern one abandoned checkout's timing/copy —
   *  a cart can span multiple sellers, so this picks whichever participating
   *  store's own delay has ALREADY elapsed and is soonest (most eager
   *  seller wins the timing), never sending more than one email total per
   *  checkout regardless of how many stores are in it. */
  private async resolveTriggerSettings(storeIds: string[], ageMinutes: number) {
    const docs = await this.r.abandonedCartSettingsModel.find({ storeId: { $in: storeIds }, isDelete: false }).lean();
    const byStore = new Map(docs.map((d: any) => [d.storeId, d]));

    const candidates = storeIds
      .map((storeId) => byStore.get(storeId) ?? { storeId, ...DEFAULT_SETTINGS })
      .filter((s: any) => s.enabled && ageMinutes >= s.delayMinutes)
      .sort((a: any, b: any) => a.delayMinutes - b.delayMinutes);

    // The real enforcement point — `enabled` defaults to true with no
    // settings doc at all, so a store's plan can only ever be checked here,
    // at send time, never trusted from whatever was true when the seller
    // last touched settings (or never touched them). A plan downgrade takes
    // effect on the very next cron tick, with no separate cleanup needed.
    for (const candidate of candidates) {
      const limits = await this.entitlementsService.getLimits((candidate as any).storeId);
      if (limits.abandonedCartRecoveryAllowed) return candidate;
    }
    return null;
  }

  private renderTemplate(template: string, vars: Record<string, string>) {
    return Object.entries(vars).reduce((text, [key, val]) => text.split(`{{${key}}}`).join(val), template);
  }

  /** Called on SchedulerService's cron tick — scans for checkouts that just
   *  crossed their triggering store's delay threshold and sends exactly one
   *  reminder email each, never a duplicate (guarded by `abandonedEmailSentAt`
   *  already being set being part of the query itself). */
  async processAbandonedCarts(): Promise<{ processed: number; sent: number }> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - RECOVERY_WINDOW_MS);
    const baseFilter = {
      status: { $in: ['pending', 'payment_pending'] },
      isDelete: false,
      abandonedEmailSentAt: null,
      abandonedEmailSuppressedAt: null,
      'items.0': { $exists: true },
    };

    // Expire old junk once so it is never selected (or scanned) again.
    await this.r.checkoutModel.updateMany(
      { ...baseFilter, updatedAt: { $lt: windowStart } },
      { $set: { abandonedEmailSuppressedAt: now } },
    );

    let sentCount = 0;
    let scanned = 0;
    let cursor: Date | null = null;

    // Newest first within the window, paged, so unsendable/not-yet-due rows
    // can never starve the checkouts behind them.
    while (sentCount < BATCH_SIZE && scanned < MAX_SCAN_PER_TICK) {
      const page: any[] = await this.r.checkoutModel
        .find({ ...baseFilter, updatedAt: cursor ? { $gte: windowStart, $lt: cursor } : { $gte: windowStart } })
        .sort({ updatedAt: -1 })
        .limit(SCAN_PAGE_SIZE)
        .lean();
      if (page.length === 0) break;
      scanned += page.length;
      cursor = new Date(page[page.length - 1].updatedAt);

      for (const checkout of page) {
        if (sentCount >= BATCH_SIZE) break;
        sentCount += await this.processOneCheckout(checkout, now);
      }
      if (page.length < SCAN_PAGE_SIZE) break;
    }

    return { processed: scanned, sent: sentCount };
  }

  /** Returns 1 if a recovery email went out, else 0. Marks the checkout
   *  permanently ineligible (abandonedEmailSuppressedAt) when it can never be
   *  sent; leaves it untouched when it is merely not due yet / retryable. */
  private async processOneCheckout(checkout: any, now: Date): Promise<number> {
    const suppress = () => this.r.checkoutModel.updateOne({ _id: checkout._id }, { $set: { abandonedEmailSuppressedAt: now } });
    {
      try {
        const ageMinutes = (now.getTime() - new Date(checkout.updatedAt).getTime()) / 60_000;
        const storeIds = [...new Set(checkout.items.map((i: any) => i.storeId))] as string[];
        const liveStores = await this.r.storeModel.countDocuments({ _id: { $in: storeIds }, isDelete: false });
        if (liveStores === 0) { await suppress(); return 0; } // no participating store left
        const trigger = await this.resolveTriggerSettings(storeIds, ageMinutes);
        if (!trigger) return 0; // no participating store's delay has elapsed yet

        const user = await this.r.userModel.findById(checkout.userId).select('name email contactEmail isGuest isDelete').lean();
        if (!user || (user as any).isDelete === true) { await suppress(); return 0; } // deleted/missing account
        const email = buyerEmail(user as any);
        if (!email) { await suppress(); return 0; } // no deliverable address (e.g. guest without contact email)

        // Recovery emails go to any shopper by default (as on Shopify), but
        // an explicit unsubscribe from this store's emails is always honored.
        const optedOut = await this.r.newsletterSubscriberModel.exists({
          storeId: trigger.storeId, email: String(email).toLowerCase(), isActive: false,
        });
        if (optedOut) {
          await suppress();
          return 0;
        }

        const store = await this.r.storeModel.findById(trigger.storeId).select('name').lean();
        const token = randomBytes(16).toString('hex');
        const cartUrl = `${API_PUBLIC_ORIGIN}/api/abandoned-cart/click/${token}`;

        const subject = this.renderTemplate(trigger.subject, { customerName: (user as any)?.name ?? 'there', storeName: (store as any)?.name ?? 'the store' });
        const message = this.renderTemplate(trigger.message, {
          customerName: (user as any)?.name ?? 'there',
          storeName: (store as any)?.name ?? 'the store',
          cartUrl,
        });

        const sent = await this.emailService.sendMail(
          email,
          subject,
          `<div style="font-family:sans-serif;max-width:520px">
            <p>${message}</p>
            <p style="margin-top:24px"><a href="${cartUrl}" style="background:#141413;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Return to your cart</a></p>
          </div>`,
        );
        if (!sent) return 0; // don't mark abandonedEmailSentAt if the send itself failed — retry next tick (bounded by the 7-day window)

        const marked = await this.r.checkoutModel.updateOne(
          { _id: checkout._id, abandonedEmailSentAt: null }, // still guards against a race with another tick/instance
          { $set: { abandonedEmailSentAt: now, abandonedRecoveryToken: token } },
        );
        if (marked.modifiedCount === 0) return 0; // another tick/instance already recorded this checkout

        for (const storeId of storeIds) {
          this.activityLogService.log({
            storeId, category: 'marketing', action: 'abandoned_cart_email_sent',
            description: `Recovery email sent for checkout ${checkout._id}`,
            actorRole: 'system', targetId: checkout._id.toString(), targetType: 'checkout',
          });
        }
      } catch (e: any) {
        this.logger.error(`processAbandonedCarts: failed for checkout ${checkout._id}: ${e?.message}`);
        return 0;
      }
    }
    return 1;
  }

  /** Public — hit when the buyer clicks the link in the recovery email.
   *  Records the click once, then the caller redirects to the cart. */
  async trackClick(token: string): Promise<void> {
    await this.r.checkoutModel.updateOne(
      { abandonedRecoveryToken: token, abandonedClickedAt: null },
      { $set: { abandonedClickedAt: new Date() } },
    );
  }

  /** Called from PaymentService.createOrder right after a real order is
   *  placed off this checkout — only actually does anything if a recovery
   *  email had genuinely been sent for it first, so a normal same-session
   *  purchase is never miscounted as a "recovery". */
  async markRecovered(checkoutId: string): Promise<void> {
    const checkout = await this.r.checkoutModel.findOne({ _id: checkoutId, abandonedEmailSentAt: { $ne: null }, recoveredAt: null });
    if (!checkout) return;

    checkout.recoveredAt = new Date();
    await checkout.save();

    const storeIds = [...new Set((checkout.items as any[]).map((i: any) => i.storeId))];
    for (const storeId of storeIds) {
      this.activityLogService.log({
        storeId, category: 'marketing', action: 'abandoned_cart_recovered',
        description: `Checkout ${checkoutId} recovered after an abandoned-cart email`,
        actorRole: 'system', targetId: checkoutId, targetType: 'checkout',
      });
    }
  }
}
