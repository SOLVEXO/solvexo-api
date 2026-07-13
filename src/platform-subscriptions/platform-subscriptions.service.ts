/* eslint-disable prettier/prettier */
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PlatformBillingNotificationsService } from './platform-billing-notifications.service';
import { StorePlan } from '../store/schemas/store.schema';
import { PLATFORM_TIERS, POS_ADDON_MONTHLY_PRICE_USD, isTierAtLeast } from './config/platform-plan-tiers.config';
import { SubscribeToTierDto } from './dto/subscribe-to-tier.dto';
import { OverrideStoreTierDto } from './dto/override-store-tier.dto';

// Same dunning constants/approach as SubscriptionsService — kept local
// (not imported) since they're plain numeric constants, not shared state.
const MAX_RENEWAL_ATTEMPTS = 3;
const RETRY_INTERVAL_DAYS = 1;

@Injectable()
export class PlatformSubscriptionsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly gateway: PaymentGatewayService,
    private readonly activityLogService: ActivityLogService,
    private readonly notifications: PlatformBillingNotificationsService,
  ) {}

  private get subModel()   { return this.db.repositories.platformSubscriptionModel; }
  private get storeModel() { return this.db.repositories.storeModel; }
  private get userModel()  { return this.db.repositories.userModel; }

  private round(n: number) { return Math.round(n * 100) / 100; }

  private addPeriod(date: Date, interval: 'monthly' | 'yearly'): Date {
    const d = new Date(date);
    if (interval === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  /** Same ownership pattern as SubscriptionsService/FinanceService. */
  private async verifyStoreOwnership(sellerId: string, storeId: string) {
    const store = await this.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');
    if (store.sellerId.toString() !== sellerId) throw new ForbiddenException('Access denied');
    return store;
  }

  private async getSellerAndStoreNames(sellerId: string, storeId: string) {
    const [seller, store] = await Promise.all([
      this.userModel.findById(sellerId).select('name email').lean(),
      this.storeModel.findById(storeId).select('name').lean(),
    ]);
    return {
      sellerName: (seller as any)?.name ?? 'there',
      sellerEmail: (seller as any)?.email ?? null,
      storeName: (store as any)?.name ?? 'your store',
    };
  }

  /** Every store gets exactly one platform subscription doc, lazily created on the free Starter tier. */
  private async getOrCreateSubscription(storeId: string, sellerId: string) {
    let sub = await this.subModel.findOne({ storeId, isDelete: false });
    if (!sub) {
      const now = new Date();
      sub = await this.subModel.create({
        storeId,
        sellerId,
        tier: StorePlan.STARTER,
        billingInterval: 'monthly',
        amountUSD: 0,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: this.addPeriod(now, 'monthly'),
        nextBillingDate: this.addPeriod(now, 'monthly'),
      });
    }
    return sub;
  }

  private enrich(sub: any) {
    const config = PLATFORM_TIERS[sub.tier as StorePlan];
    return {
      ...(sub.toObject ? sub.toObject() : sub),
      tierConfig: config,
      posAddonEligible: config?.posEligible ?? false,
      posAddonMonthlyPriceUSD: POS_ADDON_MONTHLY_PRICE_USD,
    };
  }

  // ── Seller-facing ──────────────────────────────────────────────────────────

  getTiers() {
    return { success: true, data: { tiers: Object.values(PLATFORM_TIERS), posAddonMonthlyPriceUSD: POS_ADDON_MONTHLY_PRICE_USD } };
  }

  async getMyPlan(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.getOrCreateSubscription(storeId, sellerId);
    return { success: true, data: this.enrich(sub) };
  }

  /**
   * Subscribes to (or changes to) a paid tier. Also covers the very first
   * upgrade off the free Starter tier — the proration math naturally reduces
   * to "charge full price" in that case since Starter's amountUSD is 0, so
   * there's no separate "subscribe" vs "change" code path needed.
   */
  async setTier(sellerId: string, storeId: string, dto: SubscribeToTierDto) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.getOrCreateSubscription(storeId, sellerId);
    const subId = (sub as any)._id.toString();

    if (sub.tier === dto.tier && sub.billingInterval === dto.billingInterval) {
      throw new BadRequestException('This is already your current plan and billing interval');
    }

    const newConfig = PLATFORM_TIERS[dto.tier];
    const newAmountUSD = dto.billingInterval === 'yearly'
      ? (newConfig.yearlyPriceUSD ?? this.round(newConfig.monthlyPriceUSD * 12))
      : newConfig.monthlyPriceUSD;

    const now = new Date();
    const totalPeriodMs = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, sub.currentPeriodEnd.getTime() - now.getTime());
    const remainingRatio = totalPeriodMs > 0 ? Math.min(1, remainingMs / totalPeriodMs) : 0;

    const unusedCredit = this.round(sub.amountUSD * remainingRatio);
    const totalCreditAvailable = this.round(unusedCredit + (sub.creditBalanceUSD ?? 0));
    const netDue = this.round(newAmountUSD - totalCreditAvailable);

    const historyEntry = { fromTier: sub.tier, toTier: dto.tier, changedAt: now };
    let description: string;

    if (netDue > 0) {
      const charge = await this.gateway.chargeSubscription(subId, netDue);
      if (!charge.success) {
        throw new BadRequestException(`Payment of $${netDue.toFixed(2)} failed — plan was not changed`);
      }
      sub.creditBalanceUSD = 0;
      description = `${sub.tier} → ${dto.tier} (${dto.billingInterval}) — $${netDue.toFixed(2)} charged`;
    } else {
      sub.creditBalanceUSD = this.round(-netDue);
      description = `${sub.tier} → ${dto.tier} (${dto.billingInterval}) — $${sub.creditBalanceUSD.toFixed(2)} credited to account`;
    }

    sub.tier = dto.tier;
    sub.billingInterval = dto.billingInterval;
    sub.amountUSD = this.round(newAmountUSD);
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = this.addPeriod(now, dto.billingInterval);
    sub.nextBillingDate = sub.currentPeriodEnd;
    sub.failedPaymentAttempts = 0;
    sub.canceledAt = null; // choosing a new tier cancels any pending downgrade-to-Starter
    sub.status = 'active';
    sub.tierHistory = [...(sub.tierHistory ?? []), historyEntry];
    await sub.save();

    // Denormalized cache — anything reading Store.plan directly stays correct.
    await this.storeModel.findByIdAndUpdate(storeId, { plan: dto.tier });

    this.activityLogService.log({
      storeId, category: 'platform_billing', action: 'tier_changed',
      description, actorId: sellerId, actorRole: 'seller',
      targetId: subId, targetType: 'platform_subscription', metadata: historyEntry,
    });

    return { success: true, message: description, data: this.enrich(sub) };
  }

  async cancelToStarter(sellerId: string, storeId: string, atPeriodEnd: boolean) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.getOrCreateSubscription(storeId, sellerId);

    if (sub.tier === StorePlan.STARTER) {
      throw new BadRequestException('You are already on the free Starter plan');
    }

    const now = new Date();
    let message: string;

    if (atPeriodEnd) {
      sub.canceledAt = sub.currentPeriodEnd;
      message = `Your plan will drop to Starter at the end of the current period (${sub.currentPeriodEnd.toISOString().split('T')[0]})`;
    } else {
      const fromTier = sub.tier;
      sub.tier = StorePlan.STARTER;
      sub.amountUSD = 0;
      sub.billingInterval = 'monthly';
      sub.currentPeriodStart = now;
      sub.currentPeriodEnd = this.addPeriod(now, 'monthly');
      sub.nextBillingDate = sub.currentPeriodEnd;
      sub.canceledAt = null;
      sub.creditBalanceUSD = 0; // immediate downgrade forfeits remaining time, matching the sibling module's cancel-now convention
      sub.tierHistory = [...(sub.tierHistory ?? []), { fromTier, toTier: StorePlan.STARTER, changedAt: now }];
      await this.storeModel.findByIdAndUpdate(storeId, { plan: StorePlan.STARTER });
      message = 'Your plan has been downgraded to Starter immediately';
    }

    await sub.save();

    this.activityLogService.log({
      storeId, category: 'platform_billing', action: 'tier_canceled',
      description: message, actorId: sellerId, actorRole: 'seller',
      targetId: (sub as any)._id.toString(), targetType: 'platform_subscription',
    });

    return { success: true, message, data: this.enrich(sub) };
  }

  async subscribeToPosAddon(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.getOrCreateSubscription(storeId, sellerId);

    if (!isTierAtLeast(sub.tier, StorePlan.BASIC)) {
      throw new BadRequestException(`The POS add-on requires the Basic plan or above — you're currently on ${sub.tier}`);
    }
    if (sub.posAddon?.active) {
      throw new BadRequestException('POS add-on is already active');
    }

    const subId = (sub as any)._id.toString();
    const charge = await this.gateway.chargeSubscription(`${subId}-pos`, POS_ADDON_MONTHLY_PRICE_USD);
    if (!charge.success) {
      throw new BadRequestException('POS add-on payment failed');
    }

    const now = new Date();
    sub.posAddon = {
      active: true,
      activatedAt: now,
      nextBillingDate: this.addPeriod(now, 'monthly'),
      failedPaymentAttempts: 0,
      canceledAt: null,
    } as any;
    await sub.save();

    this.activityLogService.log({
      storeId, category: 'platform_billing', action: 'pos_addon_subscribed',
      description: `POS add-on activated — $${POS_ADDON_MONTHLY_PRICE_USD}/mo`,
      actorId: sellerId, actorRole: 'seller', targetId: subId, targetType: 'platform_subscription',
    });

    return { success: true, message: 'POS add-on activated', data: this.enrich(sub) };
  }

  async cancelPosAddon(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(sellerId, storeId);
    const sub = await this.getOrCreateSubscription(storeId, sellerId);

    if (!sub.posAddon?.active) {
      throw new BadRequestException('POS add-on is not active');
    }

    sub.posAddon.active = false;
    sub.posAddon.canceledAt = new Date();
    await sub.save();

    this.activityLogService.log({
      storeId, category: 'platform_billing', action: 'pos_addon_canceled',
      description: 'POS add-on canceled', actorId: sellerId, actorRole: 'seller',
      targetId: (sub as any)._id.toString(), targetType: 'platform_subscription',
    });

    return { success: true, message: 'POS add-on canceled', data: this.enrich(sub) };
  }

  // ── Admin-facing ─────────────────────────────────────────────────────────

  adminGetTierConfig() {
    return { success: true, data: Object.values(PLATFORM_TIERS) };
  }

  async adminOverrideStoreTier(storeId: string, dto: OverrideStoreTierDto) {
    const store = await this.storeModel.findById(storeId);
    if (!store || store.isDelete) throw new NotFoundException('Store not found');

    const sub = await this.getOrCreateSubscription(storeId, store.sellerId.toString());
    const fromTier = sub.tier;
    const now = new Date();

    sub.tier = dto.tier;
    sub.amountUSD = 0; // comped — no charge on an admin override
    sub.currentPeriodStart = now;
    sub.currentPeriodEnd = this.addPeriod(now, 'yearly'); // long runway; admin can re-override anytime
    sub.nextBillingDate = sub.currentPeriodEnd;
    sub.canceledAt = null;
    sub.tierHistory = [...(sub.tierHistory ?? []), { fromTier, toTier: dto.tier, changedAt: now }];
    await sub.save();
    await this.storeModel.findByIdAndUpdate(storeId, { plan: dto.tier });

    this.activityLogService.log({
      storeId, category: 'platform_billing', action: 'tier_admin_override',
      description: `Admin override: ${fromTier} → ${dto.tier}${dto.note ? ` — ${dto.note}` : ''}`,
      actorRole: 'admin', targetId: (sub as any)._id.toString(), targetType: 'platform_subscription',
    });

    return { success: true, message: `Store tier overridden to ${dto.tier}`, data: this.enrich(sub) };
  }

  // ── Billing automation (cron-facing, not HTTP-exposed) ─────────────────────

  async processRenewals(): Promise<{ tiersProcessed: number; tiersFailed: number; posAddonsProcessed: number; posAddonsFailed: number }> {
    const now = new Date();

    // ── Paid-tier renewals ──
    const dueTiers = await this.subModel.find({
      status: { $in: ['active', 'past_due'] },
      canceledAt: null,
      amountUSD: { $gt: 0 }, // Starter never bills
      nextBillingDate: { $lte: now },
      isDelete: false,
    });

    let tiersProcessed = 0, tiersFailed = 0;

    for (const sub of dueTiers) {
      tiersProcessed++;
      try {
        const subId = (sub as any)._id.toString();
        const creditToApply = this.round(Math.min(sub.creditBalanceUSD ?? 0, sub.amountUSD));
        const chargeAmount = this.round(sub.amountUSD - creditToApply);
        const charge = chargeAmount > 0
          ? await this.gateway.chargeSubscription(subId, chargeAmount)
          : { success: true, providerChargeId: null as string | null };

        if (charge.success) {
          const periodEnd = this.addPeriod(now, sub.billingInterval as 'monthly' | 'yearly');
          sub.status = 'active';
          sub.currentPeriodStart = now;
          sub.currentPeriodEnd = periodEnd;
          sub.nextBillingDate = periodEnd;
          sub.creditBalanceUSD = this.round((sub.creditBalanceUSD ?? 0) - creditToApply);
          sub.failedPaymentAttempts = 0;
        } else {
          sub.failedPaymentAttempts = (sub.failedPaymentAttempts ?? 0) + 1;
          const { sellerName, sellerEmail, storeName } = await this.getSellerAndStoreNames(sub.sellerId, sub.storeId);
          const tierName = PLATFORM_TIERS[sub.tier as StorePlan]?.name ?? sub.tier;

          if (sub.failedPaymentAttempts >= MAX_RENEWAL_ATTEMPTS) {
            const fromTier = sub.tier;
            sub.tier = StorePlan.STARTER;
            sub.amountUSD = 0;
            sub.currentPeriodStart = now;
            sub.currentPeriodEnd = this.addPeriod(now, 'monthly');
            sub.nextBillingDate = sub.currentPeriodEnd;
            sub.failedPaymentAttempts = 0;
            sub.tierHistory = [...(sub.tierHistory ?? []), { fromTier, toTier: StorePlan.STARTER, changedAt: now }];
            await this.storeModel.findByIdAndUpdate(sub.storeId, { plan: StorePlan.STARTER });
            this.activityLogService.log({
              storeId: sub.storeId, category: 'platform_billing', action: 'tier_auto_downgraded',
              description: `Downgraded to Starter after ${MAX_RENEWAL_ATTEMPTS} failed renewal attempts`,
              actorRole: 'system', targetId: (sub as any)._id.toString(), targetType: 'platform_subscription',
            });
            if (sellerEmail) {
              await this.notifications.sendCanceledDueToFailedPayments(sellerEmail, { sellerName, storeName, tierName, maxAttempts: MAX_RENEWAL_ATTEMPTS });
            }
          } else {
            sub.status = 'past_due';
            const retryAt = new Date(now);
            retryAt.setDate(retryAt.getDate() + RETRY_INTERVAL_DAYS);
            sub.nextBillingDate = retryAt;
            if (sellerEmail) {
              await this.notifications.sendPaymentFailed(sellerEmail, {
                sellerName, storeName, tierName, amountUSD: chargeAmount,
                attemptNumber: sub.failedPaymentAttempts, maxAttempts: MAX_RENEWAL_ATTEMPTS, nextRetryDate: retryAt,
              });
            }
          }
          tiersFailed++;
        }

        await sub.save();
      } catch {
        tiersFailed++;
      }
    }

    // ── POS add-on renewals (separate, simpler — no proration/credit) ──
    const dueAddons = await this.subModel.find({
      'posAddon.active': true,
      'posAddon.nextBillingDate': { $lte: now },
      isDelete: false,
    });

    let posAddonsProcessed = 0, posAddonsFailed = 0;

    for (const sub of dueAddons) {
      posAddonsProcessed++;
      try {
        const subId = (sub as any)._id.toString();
        const charge = await this.gateway.chargeSubscription(`${subId}-pos`, POS_ADDON_MONTHLY_PRICE_USD);

        if (charge.success) {
          sub.posAddon.nextBillingDate = this.addPeriod(now, 'monthly');
          sub.posAddon.failedPaymentAttempts = 0;
        } else {
          sub.posAddon.failedPaymentAttempts = (sub.posAddon.failedPaymentAttempts ?? 0) + 1;
          if (sub.posAddon.failedPaymentAttempts >= MAX_RENEWAL_ATTEMPTS) {
            sub.posAddon.active = false;
            sub.posAddon.canceledAt = now;
            this.activityLogService.log({
              storeId: sub.storeId, category: 'platform_billing', action: 'pos_addon_auto_canceled',
              description: `POS add-on auto-canceled after ${MAX_RENEWAL_ATTEMPTS} failed renewal attempts`,
              actorRole: 'system', targetId: subId, targetType: 'platform_subscription',
            });
          } else {
            const retryAt = new Date(now);
            retryAt.setDate(retryAt.getDate() + RETRY_INTERVAL_DAYS);
            sub.posAddon.nextBillingDate = retryAt;
          }
          posAddonsFailed++;
        }

        await sub.save();
      } catch {
        posAddonsFailed++;
      }
    }

    return { tiersProcessed, tiersFailed, posAddonsProcessed, posAddonsFailed };
  }

  /** Finalizes tiers whose "downgrade at period end" date has arrived. */
  async finalizeEndOfPeriodCancellations(): Promise<{ downgraded: number }> {
    const now = new Date();
    const due = await this.subModel.find({
      canceledAt: { $ne: null, $lte: now },
      isDelete: false,
    });

    for (const sub of due) {
      const fromTier = sub.tier;
      sub.tier = StorePlan.STARTER;
      sub.amountUSD = 0;
      sub.billingInterval = 'monthly';
      sub.currentPeriodStart = now;
      sub.currentPeriodEnd = this.addPeriod(now, 'monthly');
      sub.nextBillingDate = sub.currentPeriodEnd;
      sub.canceledAt = null;
      sub.creditBalanceUSD = 0;
      sub.tierHistory = [...(sub.tierHistory ?? []), { fromTier, toTier: StorePlan.STARTER, changedAt: now }];
      await sub.save();
      await this.storeModel.findByIdAndUpdate(sub.storeId, { plan: StorePlan.STARTER });

      this.activityLogService.log({
        storeId: sub.storeId, category: 'platform_billing', action: 'tier_downgraded_at_period_end',
        description: `Downgraded from ${fromTier} to Starter at period end`,
        actorRole: 'system', targetId: (sub as any)._id.toString(), targetType: 'platform_subscription',
      });
    }

    return { downgraded: due.length };
  }

  /** Used by ProductsService to enforce the tier's product-listing limit. */
  async getProductLimitForStore(storeId: string): Promise<number | null> {
    const sub = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    const tier = (sub as any)?.tier ?? StorePlan.STARTER;
    return PLATFORM_TIERS[tier as StorePlan]?.productLimit ?? PLATFORM_TIERS[StorePlan.STARTER].productLimit;
  }
}
