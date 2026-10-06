/* eslint-disable prettier/prettier */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '@/database/databaseservice';
import { LoyaltyService } from '@/loyalty/loyalty.service';
import { StoreCreditService } from '@/store-credit/store-credit.service';
import { GuestSessionService } from '@/auth/guest-session.service';
import { CustomDomainsService } from '@/store/custom-domains.service';
import { BuyerSubscriptionWindDownService } from '@/subscriptions/buyer-subscription-wind-down.service';
import { PlatformSubscriptionsService } from '@/platform-subscriptions/platform-subscriptions.service';
import { FinanceService } from '@/finance/finance.service';
import { RedisService } from '@/redis/redis.service';
import { SellerPlatformSubscriptionsService } from '@/platform-plans/seller-platform-subscriptions.service';
import { AiCreditsService } from '@/platform-plans/ai-credits.service';
import { PlatformAddonsService } from '@/platform-plans/platform-addons.service';
import { TransactionFeeBillingService } from '@/platform-plans/transaction-fee-billing.service';
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
import { AbandonedCartService } from '@/abandoned-cart/abandoned-cart.service';
import { EmailCampaignsService } from '@/email-campaigns/email-campaigns.service';
import { InventoryService } from '@/inventory/inventory.service';
import { PurchaseOrdersService } from '@/purchase-orders/purchase-orders.service';
import { DraftOrdersService } from '@/draft-orders/draft-orders.service';
import { OrdersService } from '@/orders/orders.service';
import { MarketingAutomationsService } from '@/marketing-automations/marketing-automations.service';
import { AdminAnnouncementsService } from '@/admin-announcements/admin-announcements.service';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly loyaltyService: LoyaltyService,
    private readonly buyerSubscriptionWindDownService: BuyerSubscriptionWindDownService,
    private readonly storeCreditService: StoreCreditService,
    private readonly guestSessionService: GuestSessionService,
    private readonly customDomainsService: CustomDomainsService,
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
    private readonly abandonedCartService: AbandonedCartService,
    private readonly emailCampaignsService: EmailCampaignsService,
    private readonly inventoryService: InventoryService,
    private readonly purchaseOrdersService: PurchaseOrdersService,
    private readonly draftOrdersService: DraftOrdersService,
    private readonly ordersService: OrdersService,
    private readonly marketingAutomationsService: MarketingAutomationsService,
    private readonly adminAnnouncementsService: AdminAnnouncementsService,
    private readonly transactionFeeBillingService: TransactionFeeBillingService,
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

  /** Every 15 min — real cadence doesn't need to be tighter than that since
   *  the shortest configurable store delay is 5 minutes (see
   *  AbandonedCartSettings.delayMinutes) and a few minutes' slack on when
   *  the reminder actually goes out is normal for this kind of job. */
  @Cron('*/15 * * * *')
  async processAbandonedCarts() {
    await this.runLocked('abandoned-cart-recovery', 120_000, async () => {
      const result = await this.abandonedCartService.processAbandonedCarts();
      if (result.sent > 0) {
        this.logger.log(`processAbandonedCarts: sent ${result.sent}/${result.processed} recovery email(s)`);
      }
    });
  }

  // Runs every 5 minutes — picks up any seller Email Campaign whose
  // scheduledAt has arrived and fires it (resolves the audience, queues one
  // send job per recipient). Same cadence family as the abandoned-cart tick
  // above; a campaign scheduled "for 9am" going out a few minutes late is
  // normal for this kind of job.
  // Marketing automations (see MarketingAutomationsService). Back-in-stock is
  // time-sensitive (a restock can sell out again), so it runs often; price
  // drops hourly; win-back once a day in the morning (UTC).
  @Cron('*/10 * * * *')
  async processBackInStockAlerts() {
    await this.runLocked('automation-back-in-stock', 9 * 60_000, async () => {
      const result = await this.marketingAutomationsService.processBackInStock();
      if (result.notified > 0) this.logger.log(`Back-in-stock: ${result.notified} alert(s) sent`);
    });
  }

  @Cron('20 * * * *')
  async processPriceDropAlerts() {
    await this.runLocked('automation-price-drop', 50 * 60_000, async () => {
      const result = await this.marketingAutomationsService.processPriceDrops();
      if (result.notified > 0) this.logger.log(`Price drop: ${result.notified} alert(s) sent`);
    });
  }

  /** 1st of every month, 04:00 UTC — bills last month's accrued third-party transaction fees
   *  on each seller's platform bill (Shopify-style; see TransactionFeeBillingService). Safe to
   *  re-run: each store+month is billed once, failures/under-$0.50 totals roll forward. */
  @Cron('0 4 1 * *')
  async billTransactionFees() {
    await this.runLocked('transaction-fee-billing', 30 * 60_000, async () => {
      const r = await this.transactionFeeBillingService.billAccruedFees();
      this.logger.log(`billTransactionFees: ${r.billed} billed, ${r.carried} carried over, ${r.skipped} skipped, ${r.failed} failed (${r.stores} store(s))`);
    });
  }

  @Cron('0 9 * * *')
  async processWinBackEmails() {
    await this.runLocked('automation-win-back', 60 * 60_000, async () => {
      const result = await this.marketingAutomationsService.processWinBack();
      if (result.notified > 0) this.logger.log(`Win-back: ${result.notified} email(s) sent`);
    });
  }

  @Cron('*/5 * * * *')
  async processScheduledEmailCampaigns() {
    await this.runLocked('email-campaigns-scheduled-send', 120_000, async () => {
      const result = await this.emailCampaignsService.processScheduledCampaigns();
      if (result.processed > 0) {
        this.logger.log(`Email campaigns: ${result.processed} scheduled campaign(s) fired`);
      }
    });
  }

  // Runs every 5 minutes — same cadence as processScheduledEmailCampaigns
  // above. Flips any platform Announcement whose scheduledAt has arrived to
  // 'published' and fires its broadcast (one Notification per store, one
  // email per seller — see AdminAnnouncementsService.broadcast).
  @Cron('*/5 * * * *')
  async processScheduledAnnouncements() {
    await this.runLocked('announcements-scheduled-publish', 120_000, async () => {
      const result = await this.adminAnnouncementsService.processScheduledAnnouncements();
      if (result.processed > 0) {
        this.logger.log(`Announcements: ${result.processed} scheduled announcement(s) published`);
      }
    });
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

  // Daily — winds down the buyers who were still subscribed to a store's (now removed) VIP /
  // membership plan: paid-up subscriptions are set to end with their current period (no further
  // charge), unpaid/paused ones are cancelled, ended ones are marked canceled, and each buyer is
  // notified once. Idempotent; a no-op once no live subscription is left (see
  // BuyerSubscriptionWindDownService).
  @Cron('15 5 * * *')
  async windDownBuyerSubscriptions() {
    await this.runLocked('buyer-subscription-wind-down', 20 * 60_000, async () => {
      const r = await this.buyerSubscriptionWindDownService.windDown();
      if (r.scheduledToEnd + r.cancelledNow + r.finalized + r.failed > 0) {
        this.logger.log(`Buyer-subscription wind-down: ${r.scheduledToEnd} set to end, ${r.cancelledNow} cancelled now, ${r.finalized} finalized, ${r.failed} failed`);
      }
    });
  }

  // Every 10 minutes — re-checks custom domains that are not verified yet (so a seller's DNS change is picked up by
  // itself, like Shopify) and verified ones whose HTTPS certificate is still being issued.
  @Cron('*/10 * * * *')
  async recheckCustomDomains() {
    await this.runLocked('recheck-custom-domains', 8 * 60_000, async () => {
      const n = await this.customDomainsService.recheckPending();
      if (n > 0) this.logger.log(`Custom domains: ${n} store(s) had a domain status change`);
    });
  }

  // Daily — deletes guest-checkout sessions (and their empty carts) that never placed an order within 30 days.
  @Cron('40 5 * * *')
  async cleanStaleGuestSessions() {
    await this.runLocked('clean-stale-guests', 10 * 60_000, async () => {
      const n = await this.guestSessionService.deleteStaleGuests(30);
      if (n > 0) this.logger.log(`Guest checkout: removed ${n} stale guest session(s)`);
    });
  }

  // Hourly — expires store-credit lots whose expiry date has passed (writes the ledger 'expire' row
  // and notifies nothing; the balance query already ignores expired lots, this just keeps the history honest).
  @Cron('30 * * * *')
  async expireStoreCredit() {
    await this.runLocked('expire-store-credit', 10 * 60_000, async () => {
      const r: any = await this.storeCreditService.expireDueLots();
      if (r && (r.expired ?? r) > 0) this.logger.log(`Store credit: ${r.expired ?? r} lot(s) expired`);
    });
  }

  // (Legacy `platform-subscriptions` renewal + end-of-period crons removed: that system is retired;
  // renewals/cancellations run in the platform-plans crons below.)

  // Runs daily — executes a seller's `cancelSubscription()` once the paid
  // period they scheduled it against actually ends (system ②, current).
  @Cron('40 2 * * *')
  async finalizePlatformPlanCancellations() {
    await this.runLocked('finalize-platform-plan-cancellations', 10 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.finalizeScheduledCancellations();
      if (result.downgraded > 0) {
        this.logger.log(`Finalized ${result.downgraded} scheduled platform-plan cancellation(s)`);
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

  // Runs daily, after the trial/renewal jobs above (so a store locked/trial-
  // ended earlier in this same run is eligible immediately, not a day late)
  // — hides the storefront of any locked/trial-ended store whose own grace
  // period has elapsed. Checkout is already blocked from the moment of lock
  // regardless of this job; see expireGracePeriods()'s own doc comment.
  @Cron('0 3 * * *')
  async expirePlatformPlanGracePeriods() {
    await this.runLocked('platform-plan-grace-period-expiry', 10 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.expireGracePeriods();
      if (result.gated > 0) {
        this.logger.log(`Platform-plan grace periods expired: ${result.gated} storefront(s) hidden`);
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

  // Runs daily — "you'll be charged $X in ≤3 days" reminder for a real PAID
  // (non-trial) platform-plan subscription — closes a real, previously-open
  // gap (only the trial had a reminder before this).
  @Cron('15 9 * * *')
  async sendPlatformPlanRenewalReminders() {
    await this.runLocked('platform-plan-renewal-reminders', 15 * 60_000, async () => {
      const result = await this.sellerPlatformSubscriptionsService.sendUpcomingRenewalReminders();
      if (result.sent > 0) {
        this.logger.log(`Platform-plan renewal reminders sent: ${result.sent}`);
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

  // Runs once daily — the real emitter for `NOTIFICATION_TYPES.LOW_STOCK`,
  // which previously existed as a type with nothing ever calling `notify()`
  // for it (found during the Inventory enterprise-hardening pass). One
  // digest per store, not per SKU — see InventoryService.sendLowStockDigests.
  @Cron('0 8 * * *')
  async sendLowStockDigests() {
    await this.runLocked('inventory-low-stock-digest', 20 * 60_000, async () => {
      await this.inventoryService.sendLowStockDigests();
    });
  }

  // Runs once daily — flags any Purchase Order past its expected delivery
  // date that's still awaiting (full) receipt. See
  // PurchaseOrdersService.sendOverdueAlerts.
  @Cron('15 8 * * *')
  async sendPurchaseOrderOverdueAlerts() {
    await this.runLocked('purchase-order-overdue-alerts', 20 * 60_000, async () => {
      await this.purchaseOrdersService.sendOverdueAlerts();
    });
  }

  // Runs once daily — real automated dunning for an open Draft Order
  // invoice whose dueDate has passed unpaid (re-emails the customer the
  // same payment link + notifies the seller). See
  // DraftOrdersService.sendOverdueInvoiceReminders.
  @Cron('30 8 * * *')
  async sendDraftOrderInvoiceOverdueReminders() {
    await this.runLocked('draft-order-invoice-overdue-reminders', 20 * 60_000, async () => {
      await this.draftOrdersService.sendOverdueInvoiceReminders();
    });
  }

  // Runs once daily — real automated dunning for a completed Order carrying
  // payment terms (net-15/30/60, converted from a fulfilled-now-invoiced-
  // later Draft Order) whose dueDate has passed unpaid. See
  // OrdersService.sendOverdueOrderReminders.
  @Cron('45 8 * * *')
  async sendOrderPaymentOverdueReminders() {
    await this.runLocked('order-payment-overdue-reminders', 20 * 60_000, async () => {
      await this.ordersService.sendOverdueOrderReminders();
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
