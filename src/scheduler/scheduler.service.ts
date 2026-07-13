/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from 'src/database/databaseservice';
import { LoyaltyService } from 'src/loyalty/loyalty.service';
import { SubscriptionsService } from 'src/subscriptions/subscriptions.service';
import { PlatformSubscriptionsService } from 'src/platform-subscriptions/platform-subscriptions.service';
import { FinanceService } from 'src/finance/finance.service';
import { RedisService } from 'src/redis/redis.service';
import { SellerPlatformSubscriptionsService } from 'src/platform-plans/seller-platform-subscriptions.service';
import { AiCreditsService } from 'src/platform-plans/ai-credits.service';
import { PlatformAddonsService } from 'src/platform-plans/platform-addons.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly loyaltyService: LoyaltyService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly platformSubscriptionsService: PlatformSubscriptionsService,
    private readonly financeService: FinanceService,
    private readonly redis: RedisService,
    private readonly sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService,
    private readonly aiCreditsService: AiCreditsService,
    private readonly platformAddonsService: PlatformAddonsService,
  ) {}

  /**
   * Every cron job in this service is wrapped in a Redis distributed lock.
   * Previously none were — fine for a single instance, but the moment this
   * API is horizontally scaled (the explicit goal for "tens of thousands of
   * sellers"), every instance would independently run the exact same tick,
   * meaning every subscription would be charged once PER INSTANCE, every
   * hour. The lock TTL is set comfortably above how long the job could ever
   * realistically take, so a crashed holder still releases automatically
   * rather than wedging the job forever.
   *
   * If Redis is unavailable, `withLock` returns 'lock_not_acquired' and the
   * job is skipped for that tick rather than running unprotected — it'll
   * simply catch up on the next successful tick.
   */
  private async runLocked(jobName: string, ttlMs: number, fn: () => Promise<void>) {
    const result = await this.redis.withLock(`cron-lock:${jobName}`, ttlMs, async () => {
      await fn();
      return 'ran' as const;
    });
    if (result === 'lock_not_acquired') {
      this.logger.debug(`Skipped "${jobName}" — another instance already holds the lock (or Redis is unavailable)`);
    }
  }

  @Cron('* * * * *')
  async activateScheduledProducts() {
    await this.runLocked('activate-scheduled-products', 50_000, async () => {
      const { productModel } = this.databaseService.repositories;
      await productModel.updateMany(
        { status: 'scheduled', scheduledAt: { $lte: new Date() }, isDelete: false },
        { $set: { status: 'active', scheduledAt: null } },
      );
    });
  }

  // Runs daily — cheap no-op for members who haven't crossed their program's expiry window yet.
  @Cron('0 2 * * *')
  async expireLoyaltyPoints() {
    await this.runLocked('expire-loyalty-points', 10 * 60_000, async () => {
      await this.loyaltyService.expireInactivePoints();
    });
  }

  // Runs hourly — charges every MANUAL-provider subscription whose billing
  // period has ended, and drives the dunning/auto-cancel state machine on
  // failure. Stripe-backed subscriptions are billed by Stripe itself and are
  // reconciled via webhook instead (see StripeWebhookProcessor).
  @Cron('0 * * * *')
  async runSubscriptionRenewals() {
    await this.runLocked('subscription-renewals', 45 * 60_000, async () => {
      const result = await this.subscriptionsService.processRenewals();
      if (result.processed > 0) {
        this.logger.log(
          `Subscription renewals: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed, ${result.canceled} auto-canceled`,
        );
      }
    });
  }

  // Runs daily — finalizes subscriptions whose "cancel at period end" date has arrived.
  @Cron('30 2 * * *')
  async finalizeSubscriptionCancellations() {
    await this.runLocked('finalize-subscription-cancellations', 10 * 60_000, async () => {
      const result = await this.subscriptionsService.finalizeEndOfPeriodCancellations();
      if (result.canceled > 0) {
        this.logger.log(`Finalized ${result.canceled} end-of-period subscription cancellation(s)`);
      }
    });
  }

  // Runs every 6 hours — sends "renews in N days" reminder emails and
  // "your card was charged N days ago, update payment info" nudges for
  // subscriptions stuck in past_due.
  @Cron('0 */6 * * *')
  async sendSubscriptionReminders() {
    await this.runLocked('subscription-reminders', 20 * 60_000, async () => {
      const result = await this.subscriptionsService.sendRenewalReminders();
      if (result.sent > 0) {
        this.logger.log(`Subscription reminders: ${result.sent} renewal reminder email(s) queued`);
      }
    });
  }

  // Runs hourly — same dunning pattern as runSubscriptionRenewals, but for
  // sellers' own platform-tier plans (and their POS add-on) rather than
  // buyer subscriptions to a seller's store.
  @Cron('0 * * * *')
  async runPlatformSubscriptionRenewals() {
    const result = await this.platformSubscriptionsService.processRenewals();
    if (result.tiersProcessed > 0 || result.posAddonsProcessed > 0) {
      this.logger.log(
        `Platform billing: ${result.tiersProcessed} tier(s) processed (${result.tiersFailed} failed), ` +
        `${result.posAddonsProcessed} POS add-on(s) processed (${result.posAddonsFailed} failed)`,
      );
    }
  }

  // Runs daily — finalizes platform tiers whose "downgrade at period end" date has arrived.
  @Cron('30 2 * * *')
  async finalizePlatformCancellations() {
    const result = await this.platformSubscriptionsService.finalizeEndOfPeriodCancellations();
    if (result.downgraded > 0) {
      this.logger.log(`Finalized ${result.downgraded} end-of-period platform tier downgrade(s)`);
    }
  }

  // Runs hourly — promotes sale transactions past their clearing window from pending to
  // available balance. Previously nothing ever acted on `CLEARING_DAYS`, so seller balances
  // could never actually become payout-eligible (see the Finance module audit).
  @Cron('15 * * * *')
  async processFinanceClearingBalances() {
    await this.runLocked('finance-clearing-balances', 45 * 60_000, async () => {
      const result = await this.financeService.processClearingBalances();
      if (result.processed > 0) {
        this.logger.log(`Finance clearing: ${result.processed} transaction(s) cleared, $${result.totalAmount.toFixed(2)} moved to available balance`);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PLATFORM PLANS (seller-to-Solvexo billing) — mirrors the buyer-billing
  // cron jobs above exactly, same locking, same manual-vs-Stripe split.
  // ═══════════════════════════════════════════════════════════════════════

  @Cron('5 * * * *')
  async runPlatformPlanRenewals() {
    await this.runLocked('platform-plan-renewals', 45 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.processRenewals();
      if (result.processed > 0) {
        this.logger.log(`Platform-plan renewals: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed`);
      }
    });
  }

  // Runs daily — trials that ran out without converting to a paid card move to the free plan.
  @Cron('45 2 * * *')
  async expirePlatformPlanTrials() {
    await this.runLocked('platform-plan-trial-expiry', 10 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.expireTrials();
      if (result.expired > 0) {
        this.logger.log(`Platform-plan trials expired: ${result.expired} store(s) moved off trial`);
      }
    });
  }

  // Runs daily — "your trial ends in ≤3 days" reminder emails.
  @Cron('0 9 * * *')
  async sendPlatformPlanTrialReminders() {
    await this.runLocked('platform-plan-trial-reminders', 15 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.sendTrialEndingReminders();
      if (result.sent > 0) {
        this.logger.log(`Platform-plan trial reminders sent: ${result.sent}`);
      }
    });
  }

  // Runs on the 1st of every month at 03:00 — resets every store's AI-credit
  // balance to its current plan's monthly allowance.
  @Cron('0 3 1 * *')
  async resetAiCreditsMonthly() {
    await this.runLocked('ai-credits-monthly-reset', 30 * 60_000, async () => {
      const result = await this.aiCreditsService.resetAllMonthlyAllowances();
      this.logger.log(`AI credits reset for ${result.reset} store wallet(s)`);
    });
  }

  // Runs hourly (offset from the core platform-plan renewal tick) — charges
  // every recurring add-on (extra staff seat, priority placement, etc.)
  // whose monthly billing date has arrived.
  @Cron('20 * * * *')
  async runAddonRenewals() {
    await this.runLocked('platform-addon-renewals', 30 * 60_000, async () => {
      const result = await this.platformAddonsService.processRecurringAddonRenewals();
      if (result.processed > 0) {
        this.logger.log(`Add-on renewals: ${result.processed} processed, ${result.succeeded} succeeded, ${result.failed} failed`);
      }
    });
  }
}
