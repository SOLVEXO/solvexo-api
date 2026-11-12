/* eslint-disable prettier/prettier */
import { Injectable, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { buyerEmail } from '../common/buyer-email.util';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EmailService } from '@/otp/services/email.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { randomBytes } from 'crypto';
import { UpdateAbandonedCartSettingsDto } from './dto/update-abandoned-cart-settings.dto';

import { API_PUBLIC_ORIGIN } from '@/common/api-origin';
import { discountCodeHtml, escapeHtml, storePublicUrl, textToHtml, unsubscribeHeaders } from '@/newsletter/marketing-email.util';
import { signMarketingOptOutToken, verifyMarketingOptOutToken } from '@/common/marketing-optout-token.util';
const DEFAULT_SETTINGS = { enabled: true, delayMinutes: 60, subject: 'You left something in your cart', message: "Hi {{customerName}}, you still have items waiting in your cart at {{storeName}}. Complete your order before they're gone: {{cartUrl}}" };
const SECOND_DEFAULTS = { discountCode: null as string | null, secondReminderEnabled: false, secondReminderDelayHours: 24, secondSubject: 'Still thinking it over?', secondMessage: 'Hi {{customerName}}, your cart at {{storeName}} is still waiting for you. This is our last reminder: {{cartUrl}}' };
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

  /** Marketing emails each store may still send this month, worked out once per cron tick (see processAbandonedCarts). */
  private tickRoom = new Map<string, number>();

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
    // Settings saved before the discount code / second reminder existed simply have no such fields: they read as the defaults.
    return existing ? { ...SECOND_DEFAULTS, ...existing } : { storeId, ...DEFAULT_SETTINGS, ...SECOND_DEFAULTS, _id: null };
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
    const changes: Record<string, any> = { ...dto };
    if ('discountCode' in dto) changes.discountCode = await this.validateDiscountCode(storeId, dto.discountCode);
    // DEFAULT_SETTINGS only fills fields the seller has not set; a field in this very update must not also be a default.
    const defaults: Record<string, any> = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(changes)) delete defaults[k];
    const settings = await this.r.abandonedCartSettingsModel.findOneAndUpdate(
      { storeId },
      { $set: { storeId, ...changes }, $setOnInsert: defaults },
      { new: true, upsert: true },
    );
    return { success: true, message: 'Abandoned cart settings updated', data: settings };
  }

  /** The code must be a real, live coupon of THIS store (same rule as the welcome / win-back emails); empty removes it. */
  private async validateDiscountCode(storeId: string, raw: unknown): Promise<string | null> {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
    if (typeof raw !== 'string') throw new BadRequestException('Invalid discount code');
    const code = raw.trim().toUpperCase();
    const coupon = await this.r.couponModel.findOne({ storeId, code, isDelete: false }).lean();
    if (!coupon) throw new BadRequestException(`Discount code "${code}" does not exist in this store. Create it under Marketing → Coupons first.`);
    return code;
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
    this.tickRoom = new Map();
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

    // Optional second reminders (shares this tick's per-store allowance numbers).
    try { sentCount += await this.processSecondReminders(now); } catch (e: any) { this.logger.error(`second reminders failed: ${e?.message}`); }

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

        // The plan's monthly marketing-email allowance covers recovery mails too. Out of room: leave the checkout untouched
        // (it is retried on the next tick, and expires after the 7-day window) instead of sending past the plan.
        const tickStore = String(trigger.storeId);
        if (!this.tickRoom.has(tickStore)) this.tickRoom.set(tickStore, await this.entitlementsService.getEmailRoom(tickStore, 'abandonedCartRecoveryAllowed'));
        if ((this.tickRoom.get(tickStore) ?? 0) < 1) return 0;

        const store = await this.r.storeModel.findById(trigger.storeId).select('name contactEmail').lean();
        const token = randomBytes(16).toString('hex');
        // `s` = the store whose cart the buyer should land on (checked against the checkout's own items when the link is clicked).
        const cartUrl = `${API_PUBLIC_ORIGIN}/api/abandoned-cart/click/${token}?s=${encodeURIComponent(String(trigger.storeId))}`;

        // Claim the checkout BEFORE sending, so two overlapping ticks/instances can never both mail it; released again if the send fails.
        const claim = await this.r.checkoutModel.updateOne(
          { _id: checkout._id, abandonedEmailSentAt: null },
          { $set: { abandonedEmailSentAt: now, abandonedRecoveryToken: token, abandonedEmailStoreId: tickStore } },
        );
        if (claim.modifiedCount === 0) return 0; // another tick/instance already took this checkout

        const customerName = (user as any)?.name ?? 'there';
        const storeName = (store as any)?.name ?? 'the store';
        const subject = this.renderTemplate(trigger.subject, { customerName, storeName });
        // The template is plain text typed by the seller and the buyer's name is buyer-controlled, so the whole message is escaped.
        const discountCode: string | null = (trigger as any).discountCode ?? null;
        const { html, unsubscribeUrl } = this.buildRecoveryMail({ template: trigger.message, customerName, storeName, cartUrl, storeId: String(trigger.storeId), email, discountCode });
        const sent = await this.emailService.sendMail(
          email,
          subject,
          html,
          (store as any)?.contactEmail ?? null,
          unsubscribeHeaders(unsubscribeUrl),
          undefined,
          (store as any)?.name ?? null,
        );
        if (!sent) {
          // The send itself failed: release the claim so the next tick retries (bounded by the 7-day window).
          await this.r.checkoutModel.updateOne({ _id: checkout._id }, { $set: { abandonedEmailSentAt: null, abandonedRecoveryToken: null, abandonedEmailStoreId: null } });
          return 0;
        }
        this.tickRoom.set(tickStore, (this.tickRoom.get(tickStore) ?? 1) - 1);

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

  /** The reminder's HTML: the seller's text (escaped: it is plain text and the buyer's name is buyer-controlled), the optional
   *  discount code, a button back to the cart, and the one-click unsubscribe footer every marketing-type mail carries. */
  private buildRecoveryMail(a: { template: string; customerName: string; storeName: string; cartUrl: string; storeId: string; email: string; discountCode: string | null }) {
    const message = textToHtml(this.renderTemplate(a.template, { customerName: a.customerName, storeName: a.storeName, cartUrl: a.cartUrl, discountCode: a.discountCode ?? '' }));
    const unsubscribeUrl = `${API_PUBLIC_ORIGIN}/api/abandoned-cart/unsubscribe/${signMarketingOptOutToken(a.storeId, a.email)}`;
    const html = `<div style="font-family:sans-serif;max-width:520px">
            ${message}
            ${a.discountCode ? discountCodeHtml(a.discountCode) : ''}
            <p style="margin-top:24px"><a href="${a.cartUrl}" style="background:#141413;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Return to your cart</a></p>
            <p style="margin-top:28px;padding-top:14px;border-top:1px solid #eee;color:#888;font-size:12px">You got this because you started a checkout at ${escapeHtml(a.storeName)}. <a href="${unsubscribeUrl}" style="color:#888">Unsubscribe</a> if you do not want reminders like this.</p>
          </div>`;
    return { html, unsubscribeUrl };
  }

  /**
   * The optional second reminder: ONE more mail, `secondReminderDelayHours` after the first, only while the checkout is still
   * unpaid and the seller switched it on. Same rules as the first: never to someone who unsubscribed, never past the plan's monthly
   * marketing emails, claimed before sending so two ticks can not both send it, claim released when the send fails.
   */
  async processSecondReminders(now = new Date()): Promise<number> {
    const windowStart = new Date(now.getTime() - RECOVERY_WINDOW_MS);
    const earliest = new Date(now.getTime() - 6 * 3_600_000); // the shortest allowed delay is 6 h
    const page: any[] = await this.r.checkoutModel
      .find({
        status: { $in: ['pending', 'payment_pending'] }, isDelete: false, recoveredAt: null,
        abandonedSecondEmailSentAt: null, abandonedEmailStoreId: { $ne: null },
        abandonedEmailSentAt: { $gte: windowStart, $lte: earliest },
      })
      .sort({ abandonedEmailSentAt: 1 })
      .limit(SCAN_PAGE_SIZE)
      .lean();
    let sent = 0;
    for (const checkout of page) {
      if (sent >= BATCH_SIZE) break;
      sent += await this.sendSecondReminder(checkout, now);
    }
    return sent;
  }

  private async sendSecondReminder(checkout: any, now: Date): Promise<number> {
    try {
      const storeId = String(checkout.abandonedEmailStoreId);
      const settings: any = await this.getOrDefaultSettings(storeId);
      if (!settings.enabled || !settings.secondReminderEnabled) return 0;
      const hoursSinceFirst = (now.getTime() - new Date(checkout.abandonedEmailSentAt).getTime()) / 3_600_000;
      if (hoursSinceFirst < (settings.secondReminderDelayHours ?? 24)) return 0;

      const limits = await this.entitlementsService.getLimits(storeId);
      if (!limits.abandonedCartRecoveryAllowed) return 0;
      const user: any = await this.r.userModel.findById(checkout.userId).select('name email contactEmail isGuest isDelete').lean();
      if (!user || user.isDelete === true) return 0;
      const email = buyerEmail(user);
      if (!email) return 0;
      const optedOut = await this.r.newsletterSubscriberModel.exists({ storeId, email: String(email).toLowerCase(), isActive: false });
      if (optedOut) return 0;
      if (!this.tickRoom.has(storeId)) this.tickRoom.set(storeId, await this.entitlementsService.getEmailRoom(storeId, 'abandonedCartRecoveryAllowed'));
      if ((this.tickRoom.get(storeId) ?? 0) < 1) return 0;

      const claim = await this.r.checkoutModel.updateOne(
        { _id: checkout._id, abandonedSecondEmailSentAt: null, recoveredAt: null },
        { $set: { abandonedSecondEmailSentAt: now } },
      );
      if (claim.modifiedCount === 0) return 0;

      const store: any = await this.r.storeModel.findById(storeId).select('name contactEmail').lean();
      const customerName = user.name ?? 'there';
      const storeName = store?.name ?? 'the store';
      // The click link keeps the first mail's token, so a click from either mail is tracked on the same checkout.
      const cartUrl = `${API_PUBLIC_ORIGIN}/api/abandoned-cart/click/${checkout.abandonedRecoveryToken}?s=${encodeURIComponent(storeId)}`;
      const subject = this.renderTemplate(settings.secondSubject, { customerName, storeName });
      const { html, unsubscribeUrl } = this.buildRecoveryMail({ template: settings.secondMessage, customerName, storeName, cartUrl, storeId, email, discountCode: settings.discountCode ?? null });
      const ok = await this.emailService.sendMail(email, subject, html, store?.contactEmail ?? null, unsubscribeHeaders(unsubscribeUrl), undefined, store?.name ?? null);
      if (!ok) {
        await this.r.checkoutModel.updateOne({ _id: checkout._id }, { $set: { abandonedSecondEmailSentAt: null } });
        return 0;
      }
      this.tickRoom.set(storeId, (this.tickRoom.get(storeId) ?? 1) - 1);
      this.activityLogService.log({
        storeId, category: 'marketing', action: 'abandoned_cart_second_email_sent',
        description: `Second recovery email sent for checkout ${checkout._id}`,
        actorRole: 'system', targetId: String(checkout._id), targetType: 'checkout',
      });
      return 1;
    } catch (e: any) {
      this.logger.error(`processSecondReminders: failed for checkout ${checkout._id}: ${e?.message}`);
      return 0;
    }
  }

  /** Public — hit when the buyer clicks the link in the recovery email.
   *  Records the click once and returns the address of the STORE's own cart (its verified custom domain, else its
   *  `<slug>.solvexo.store`), or null when the link is unknown so the caller can fall back. `storeId` comes from the
   *  link, so it is only trusted when it is really one of the checkout's stores. */
  async trackClick(token: string, storeId?: string): Promise<string | null> {
    if (!token || typeof token !== 'string') return null;
    await this.r.checkoutModel.updateOne(
      { abandonedRecoveryToken: token, abandonedClickedAt: null },
      { $set: { abandonedClickedAt: new Date() } },
    );
    const checkout: any = await this.r.checkoutModel.findOne({ abandonedRecoveryToken: token }).select('items.storeId').lean();
    if (!checkout) return null;
    const storeIds: string[] = [...new Set((checkout.items ?? []).map((i: any) => String(i.storeId)))] as string[];
    const target = storeId && storeIds.includes(String(storeId)) ? String(storeId) : storeIds[0];
    if (!target) return null;
    const store = await this.r.storeModel.findOne({ _id: target, isDelete: { $ne: true } }).select('slug customDomain customDomainStatus').lean();
    const base = storePublicUrl(store as any);
    return base ? `${base}/cart` : null;
  }

  /** Public — the unsubscribe link of a recovery email. Records an explicit opt-out for THIS store and address (creating the
   *  subscriber row as "unsubscribed" when the shopper was never on the list), which is exactly what `processOneCheckout`
   *  and the campaigns check before sending. Idempotent. Returns whether the link was valid and the store name for the page. */
  async unsubscribeByToken(token: string): Promise<{ ok: boolean; storeName: string | null }> {
    const claim = verifyMarketingOptOutToken(token);
    if (!claim) return { ok: false, storeName: null };
    const store: any = await this.r.storeModel.findOne({ _id: claim.storeId }).select('name').lean();
    const existing: any = await this.r.newsletterSubscriberModel.findOne({ storeId: claim.storeId, email: claim.email });
    if (existing) {
      if (existing.isActive || existing.pendingConfirmation) {
        await this.r.newsletterSubscriberModel.updateOne(
          { _id: existing._id },
          { $set: { isActive: false, pendingConfirmation: false, confirmToken: null, unsubscribedAt: new Date() } },
        );
      }
    } else {
      try {
        await this.r.newsletterSubscriberModel.create({
          storeId: claim.storeId, email: claim.email, userId: null, source: 'abandoned_cart_optout',
          unsubscribeToken: randomBytes(24).toString('hex'), isActive: false, pendingConfirmation: false,
          consentAt: null, unsubscribedAt: new Date(),
        });
      } catch (e: any) {
        if (e?.code !== 11000) throw e; // two clicks at once: the other one already recorded it
      }
    }
    return { ok: true, storeName: store?.name ?? null };
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
