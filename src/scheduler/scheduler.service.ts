/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '@/database/databaseservice';
import { LoyaltyService } from '@/loyalty/loyalty.service';
import { SubscriptionsService } from '@/subscriptions/subscriptions.service';
import { PlatformSubscriptionsService } from '@/platform-subscriptions/platform-subscriptions.service';
import { FinanceService } from '@/finance/finance.service';
import { RedisService } from '@/redis/redis.service';
import { SellerPlatformSubscriptionsService } from '@/platform-plans/seller-platform-subscriptions.service';
import { AiCreditsService } from '@/platform-plans/ai-credits.service';
import { PlatformAddonsService } from '@/platform-plans/platform-addons.service';
import { SeoSitemapService } from '@/seo/services/seo-sitemap.service';
import { SeoMonitoringService } from '@/seo/services/seo-monitoring.service';
import { SeoAuditService } from '@/seo/services/seo-audit.service';
import { AdminMarketingService } from '@/admin-marketing/admin-marketing.service';
import { PromotionsService } from '@/promotions/promotions.service';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { AdminFinanceService } from '@/admin-finance/admin-finance.service';
import { BookingsService } from '@/bookings/bookings.service';
import { WhatsAppCloudProvider } from '@/integrations/providers/whatsapp-cloud.provider';
import { decryptCredential } from '@/common/credential-encryption.util';

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
    private readonly seoSitemapService: SeoSitemapService,
    private readonly seoMonitoringService: SeoMonitoringService,
    private readonly seoAuditService: SeoAuditService,
    private readonly adminMarketingService: AdminMarketingService,
    private readonly promotionsService: PromotionsService,
    private readonly exchangeRateService: ExchangeRateService,
    private readonly activityLogService: ActivityLogService,
    private readonly adminFinanceService: AdminFinanceService,
    private readonly bookingsService: BookingsService,
    private readonly whatsAppProvider: WhatsAppCloudProvider,
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

  // Sibling to activateScheduledProducts above — StoreBlogService#publish
  // previously had no way to go live at a future date at all (always
  // published immediately); a scheduled post now flips to 'published' here
  // once due, `publishedAt` set to the moment it was actually scheduled for.
  @Cron('* * * * *')
  async publishScheduledBlogPosts() {
    await this.runLocked('publish-scheduled-blog-posts', 50_000, async () => {
      const { blogPostModel } = this.databaseService.repositories;
      await blogPostModel.updateMany(
        { status: 'scheduled', scheduledAt: { $lte: new Date() }, isDelete: false },
        [{ $set: { status: 'published', publishedAt: '$scheduledAt', scheduledAt: null } }],
        // See ContentVersioningService for why this option is required on
        // Mongoose 9 for any array (aggregation-pipeline) update — without
        // it this cron silently threw every single run.
        { updatePipeline: true },
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
    await this.runLocked('platform-subscription-renewals', 45 * 60_000, async () => {
      const result = await this.platformSubscriptionsService.processRenewals();
      if (result.tiersProcessed > 0 || result.posAddonsProcessed > 0) {
        this.logger.log(
          `Platform billing: ${result.tiersProcessed} tier(s) processed (${result.tiersFailed} failed), ` +
          `${result.posAddonsProcessed} POS add-on(s) processed (${result.posAddonsFailed} failed)`,
        );
      }
    });
  }

  // Runs daily — finalizes platform tiers whose "downgrade at period end" date has arrived.
  // Runs daily — executes a seller's `cancelSubscription()` once the paid
  // period they scheduled it against actually ends (system ②, current).
  // Distinct from `finalizePlatformCancellations` below, which is the legacy
  // system ① equivalent — do not merge these, they act on different schemas.
  @Cron('40 2 * * *')
  async finalizePlatformPlanCancellations() {
    await this.runLocked('finalize-platform-plan-cancellations', 10 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.finalizeScheduledCancellations();
      if (result.downgraded > 0) {
        this.logger.log(`Finalized ${result.downgraded} scheduled platform-plan cancellation(s)`);
      }
    });
  }

  @Cron('30 2 * * *')
  async finalizePlatformCancellations() {
    await this.runLocked('finalize-platform-cancellations', 10 * 60_000, async () => {
      const result = await this.platformSubscriptionsService.finalizeEndOfPeriodCancellations();
      if (result.downgraded > 0) {
        this.logger.log(`Finalized ${result.downgraded} end-of-period platform tier downgrade(s)`);
      }
    });
  }

  // Runs every minute (same cadence as activateScheduledProducts above, for
  // the same reason — a time-based state flip) — moves platform sale
  // Campaigns whose endDate has passed from 'active' to 'ended' and compacts
  // the remaining active campaigns' rotation `order` values so there's never
  // a gap where an expired campaign's slot used to be. This is just the
  // backstop for when nobody's actively viewing the admin list — the list
  // read itself (AdminMarketingService.listCampaigns) also self-heals on
  // every load, which is what actually makes this feel instant rather than
  // capped at a 1-minute lag.
  @Cron('* * * * *')
  async expireCampaigns() {
    await this.runLocked('campaign-expiry', 50_000, async () => {
      const result = await this.adminMarketingService.expireCampaigns();
      if (result.expired > 0) {
        this.logger.log(`Campaigns expired: ${result.expired} moved to 'ended', rotation order compacted`);
      }
    });
  }

  // Sibling to expireCampaigns() above — activates paid+approved PromotionRequests
  // whose startAt has arrived, expires ones past endAt, fires the going-live/
  // expiring-soon/expired notifications, and compacts the resulting Banner rows'
  // rotation order for any placement it touched.
  @Cron('* * * * *')
  async expirePromotions() {
    await this.runLocked('promotion-expiry', 50_000, async () => {
      const result = await this.promotionsService.runExpiryAndActivation();
      if (result.activated > 0 || result.expired > 0) {
        this.logger.log(`Promotions: ${result.activated} activated, ${result.expired} expired, ${result.expiringSoonNotified} expiring-soon notices sent`);
      }
    });
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

  // Runs daily — each seller's PayoutSchedule carries its OWN cadence
  // (daily/weekly/biweekly/monthly) and `nextPayoutAt`; this tick just checks
  // which schedules are due today and lets FinanceService decide per-store
  // eligibility (balance above threshold, active default method, nothing
  // already in flight). Auto-created payouts land in the same admin queue as
  // a seller-initiated withdrawal — nothing here disburses money without an
  // admin's approval (see FinanceService.processScheduledPayouts).
  @Cron('0 10 * * *')
  async runScheduledPayouts() {
    await this.runLocked('scheduled-payouts', 30 * 60_000, async () => {
      const result = await this.financeService.processScheduledPayouts();
      if (result.payoutsCreated > 0 || result.schedulesChecked > 0) {
        this.logger.log(
          `Scheduled payouts: ${result.schedulesChecked} schedule(s) due, ${result.payoutsCreated} payout(s) auto-created ($${result.totalAmount.toFixed(2)} total), ${result.skipped} skipped`,
        );
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

  // Runs daily — rebuilds every chunked sitemap (products/stores/categories/
  // pages) so new/changed/removed listings stay reflected in what Google/
  // Bing crawl. Always queued (seo-sitemap), never generated inline here —
  // this method just enqueues the job and returns immediately.
  @Cron('0 4 * * *')
  async regenerateSitemaps() {
    await this.runLocked('seo-sitemap-regenerate', 5 * 60_000, async () => {
      await this.seoSitemapService.enqueueRegenerate();
    });
  }

  // Runs nightly — pulls index coverage + search performance for every
  // connected GSC/Bing integration (platform + every store).
  @Cron('0 1 * * *')
  async syncSearchConsoleData() {
    await this.runLocked('seo-search-console-sync', 20 * 60_000, async () => {
      const result = await this.seoMonitoringService.syncAllSearchConsoleData();
      if (result.synced + result.failed > 0) {
        this.logger.log(`SEO search console sync: ${result.synced} synced, ${result.failed} failed`);
      }
    });
  }

  // Runs nightly — pulls organic-session counts for every connected GA4 integration.
  @Cron('30 1 * * *')
  async syncGoogleAnalyticsData() {
    await this.runLocked('seo-ga4-sync', 20 * 60_000, async () => {
      const result = await this.seoMonitoringService.syncAllGoogleAnalyticsData();
      if (result.synced + result.failed > 0) {
        this.logger.log(`SEO GA4 sync: ${result.synced} synced, ${result.failed} failed`);
      }
    });
  }

  // Runs weekly (Sunday 03:00) — pulls Core Web Vitals field data (CrUX) for
  // the platform's top-trafficked product/store pages. Capped list, not the
  // whole catalog — the PageSpeed Insights API has real per-call latency and
  // rate limits.
  @Cron('0 3 * * 0')
  async refreshCoreWebVitals() {
    await this.runLocked('seo-cwv-refresh', 30 * 60_000, async () => {
      const urls = await this.seoMonitoringService.getTopUrlsForCwv();
      const result = await this.seoMonitoringService.refreshCoreWebVitals(urls, null);
      this.logger.log(`Core Web Vitals refresh: ${result.measured} measured, ${result.failed} failed`);
    });
  }

  // Runs daily — auto-runs the SEO audit for every store whose platform plan
  // includes `advancedSeoToolsAllowed`, so sellers on qualifying plans see a
  // fresh score without manually clicking "run audit".
  @Cron('0 5 * * *')
  async runScheduledSeoAudits() {
    await this.runLocked('seo-scheduled-audits', 30 * 60_000, async () => {
      const result = await this.seoAuditService.enqueueScheduledRuns();
      this.logger.log(`Scheduled SEO audits: ${result.queued} store(s) queued`);
    });
  }

  // Daily refresh of the authoritative PKR/USD (and later EUR/GBP/...) rate
  // — see ExchangeRateService. Checkout/settlement never call the provider
  // directly; they always read whatever this cron last persisted, so a slow
  // or unreachable provider never blocks a live checkout.
  @Cron('0 3 * * *')
  async refreshExchangeRates() {
    await this.runLocked('fx-refresh', 60_000, async () => {
      await this.exchangeRateService.refreshFromProvider();
    });
  }

  // Hourly check only — never mutates a rate, just surfaces an
  // isSecurityAlert activity-log entry if a currency's current rate has
  // gone stale beyond FxConfig.staleRateAlertThresholdHours (e.g. the daily
  // refresh above has been silently failing for days).
  @Cron('30 * * * *')
  async checkFxRateStaleness() {
    await this.runLocked('fx-staleness-check', 30_000, async () => {
      const staleness = await this.exchangeRateService.getStaleness();
      for (const [currency, info] of Object.entries(staleness)) {
        if (info?.isStale) {
          this.logger.warn(`FX rate for ${currency} is stale: ${info.hoursOld.toFixed(1)}h old`);
          await this.activityLogService.log({
            storeId: 'platform',
            category: 'finance',
            action: 'fx_rate_stale',
            description: `${currency} exchange rate is ${info.hoursOld.toFixed(1)}h old — provider refresh may be failing`,
            actorId: 'system',
            actorRole: 'system',
            isSecurityAlert: true,
          });
        }
      }
    });
  }

  // Daily reconciliation — persists a snapshot comparing buyer collections
  // against the ledger (see AdminFinanceService#getReconciliation) and
  // raises a security alert per currency with a real discrepancy. Previously
  // this comparison only ran on-demand when someone happened to load the
  // admin dashboard, so a drift occurring between two dashboard views could
  // go unnoticed indefinitely.
  @Cron('15 2 * * *')
  async runReconciliation() {
    await this.runLocked('finance-reconciliation', 60_000, async () => {
      await this.adminFinanceService.runAndPersistReconciliation(1);
    });
  }

  // Daily FX exposure check — alerts if the platform's open non-settlement-
  // currency position exceeds FxConfig.exposureThresholdUSD. Visibility
  // only, no automatic hedging/trading.
  @Cron('30 2 * * *')
  async checkFxExposure() {
    await this.runLocked('fx-exposure-check', 30_000, async () => {
      await this.adminFinanceService.runFxExposureCheck();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BOOKINGS — parallel to the Subscriptions cron jobs above, same locking.
  // ═══════════════════════════════════════════════════════════════════════

  // Runs every 15 minutes — flips 'confirmed' bookings whose date+endTime
  // has already passed to 'completed'.
  @Cron('*/15 * * * *')
  async completePastBookings() {
    await this.runLocked('bookings-complete-past', 10 * 60_000, async () => {
      const result = await this.bookingsService.completePastBookings();
      if (result.completed > 0) {
        this.logger.log(`Bookings: ${result.completed} past booking(s) marked completed`);
      }
    });
  }

  // Runs daily — mirrors expireLoyaltyPoints' daily style: marks
  // PackagePurchase docs past their expiresAt (still 'active') as 'expired'.
  @Cron('0 2 * * *')
  async expirePackagePurchases() {
    await this.runLocked('bookings-expire-packages', 10 * 60_000, async () => {
      const result = await this.bookingsService.expirePackagePurchases();
      if (result.expired > 0) {
        this.logger.log(`Bookings: ${result.expired} package purchase(s) expired`);
      }
    });
  }

  // Runs every 6 hours — mirrors sendSubscriptionReminders: notifies buyers
  // with a confirmed booking in the next ~24h (deduped via reminderSentAt).
  @Cron('0 */6 * * *')
  async sendBookingReminders() {
    await this.runLocked('bookings-send-reminders', 20 * 60_000, async () => {
      const result = await this.bookingsService.sendBookingReminders();
      if (result.sent > 0) {
        this.logger.log(`Bookings: ${result.sent} reminder notification(s) sent`);
      }
    });
  }

  // Runs daily — catches a WhatsApp connection that broke outside our own
  // disconnect flow (seller revoked access in Meta Business Manager, token
  // expired) so it surfaces as `needs_reauth` on the seller's integrations
  // page instead of silently failing the next time an order notification
  // tries to send. See WhatsAppCloudProvider.checkTokenValidity.
  @Cron('0 3 * * *')
  async checkWhatsAppTokenHealth() {
    await this.runLocked('whatsapp-token-health', 20 * 60_000, async () => {
      const { storeIntegrationModel } = this.databaseService.repositories;
      const connected = await storeIntegrationModel.find({ type: 'whatsapp', status: 'connected' });

      let flagged = 0;
      for (const integration of connected) {
        if (!integration.credentialsEncrypted) continue;
        let accessToken: string;
        try {
          accessToken = JSON.parse(decryptCredential(integration.credentialsEncrypted, 'INTEGRATIONS')).accessToken;
        } catch {
          continue;
        }

        const { isValid, expiresAt } = await this.whatsAppProvider.checkTokenValidity(accessToken);
        const expiringSoon = expiresAt ? expiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000 : false;
        if (isValid && !expiringSoon) continue;

        await storeIntegrationModel.updateOne(
          { _id: integration._id },
          { $set: { status: 'needs_reauth', lastError: isValid ? 'Access token expiring soon' : 'Access token is no longer valid' } },
        );
        await this.activityLogService.log({
          storeId: integration.storeId,
          category: 'integrations',
          action: 'integration.needs_reauth',
          description: 'WhatsApp connection needs to be reconnected — access token invalid or expiring soon',
          actorId: 'system',
          actorRole: 'system',
          targetId: String(integration._id),
          targetType: 'StoreIntegration',
          isSecurityAlert: true,
        });
        flagged++;
      }
      if (flagged > 0) {
        this.logger.log(`WhatsApp token health: ${flagged} integration(s) flagged needs_reauth`);
      }
    });
  }
}
