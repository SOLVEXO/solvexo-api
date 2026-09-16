/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { AdminAnalyticsService } from '../admin-analytics/admin-analytics.service';
import { PlatformHealthService } from '../platform-health/platform-health.service';
import { allTimeSellerActivity, deriveSellerSalesStatus } from '../analytics/utils/order-aggregation.util';
import { round } from '../analytics/utils/analytics-number.util';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface PlatformAlert {
  id: string;
  severity: AlertSeverity;
  category: string;
  message: string;
  metricValue: number | string;
  threshold: string;
}

const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

// Phase 11 — Alerts & Insights. Standing rule: DETERMINISTIC RULES ONLY,
// no AI-generated insights. Every alert this service can produce is a
// fixed, named, hardcoded-threshold comparison against a real number that
// some earlier, real-data-only phase already computes — never a language-
// model summary, a "smart"/learned anomaly score, or a subjective
// judgment call. This service does not query anything new itself beyond
// one small real seller-status tally (reusing the exact same
// deriveSellerSalesStatus/allTimeSellerActivity utilities Phase 3 already
// built and tested) — everything else is composed from
// AdminAnalyticsService and PlatformHealthService's own already-real
// return values, per the "no rebuild of working logic" rule.
@Injectable()
export class PlatformAlertsService {
  private static readonly WEBHOOK_FAILURE_RATE_THRESHOLD_PERCENT = 10;
  private static readonly WEBHOOK_MIN_SAMPLE_SIZE = 5; // below this, a single failure would swing the rate wildly — not a reliable signal yet
  private static readonly PAYMENT_FAILURE_RATE_THRESHOLD_PERCENT = 10;
  private static readonly PAYMENT_MIN_SAMPLE_SIZE = 10;
  private static readonly REFUND_RATE_THRESHOLD_PERCENT = 15;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminAnalyticsService: AdminAnalyticsService,
    private readonly platformHealthService: PlatformHealthService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Real, all-time (never period-scoped — see Phase 3's own reasoning on
   *  admin-analytics.service.ts's getSellerPerformance) counts of sellers
   *  by their deterministic sales-recency status. Reuses the exact same
   *  pure functions Phase 3 built and tested — this only tallies counts
   *  instead of returning a paginated per-seller list. */
  private async getSellerStatusCounts(): Promise<{ new: number; active: number; atRisk: number; dormant: number }> {
    const [sellers, activity] = await Promise.all([
      this.r.sellerModel.find({ isDelete: false }).select('createdAt').lean(),
      allTimeSellerActivity(this.r.orderModel),
    ]);
    const activityMap = new Map(activity.map((a) => [a.sellerId, a]));

    const counts = { new: 0, active: 0, atRisk: 0, dormant: 0 };
    for (const s of sellers as any[]) {
      const status = deriveSellerSalesStatus(s.createdAt, activityMap.get(s._id.toString())?.lastOrderAt ?? null);
      if (status === 'new') counts.new += 1;
      else if (status === 'active') counts.active += 1;
      else if (status === 'at_risk') counts.atRisk += 1;
      else counts.dormant += 1;
    }
    return counts;
  }

  async getAlerts(query: any) {
    const [health, payments, overview, inventory, sellerStatusCounts] = await Promise.all([
      this.platformHealthService.getPlatformHealth(query),
      this.adminAnalyticsService.getPaymentBreakdown(query),
      this.adminAnalyticsService.getOverview(query),
      this.adminAnalyticsService.getInventoryInsights(query),
      this.getSellerStatusCounts(),
    ]);

    const alerts: PlatformAlert[] = [];

    // 1. CRITICAL — a real dependency (Mongo/Redis) is down right now, per
    // the exact same live check HealthController exposes at /health/ready.
    if (health.data.dependencyStatus.mongodb === 'down') {
      alerts.push({
        id: 'dependency-mongodb-down', severity: 'critical', category: 'Infrastructure',
        message: 'MongoDB is reporting down on the live dependency health check.',
        metricValue: 'down', threshold: 'up',
      });
    }
    if (health.data.dependencyStatus.redis === 'down') {
      alerts.push({
        id: 'dependency-redis-down', severity: 'critical', category: 'Infrastructure',
        message: 'Redis is reporting disconnected.',
        metricValue: 'down', threshold: 'up',
      });
    }

    // 2. WARNING — real webhook-processing failure rate above a fixed
    // threshold (subscription-billing webhook only — see PlatformHealthService).
    const wh = health.data.webhookReliability;
    if (wh.totalEvents >= PlatformAlertsService.WEBHOOK_MIN_SAMPLE_SIZE && wh.failureRatePercent > PlatformAlertsService.WEBHOOK_FAILURE_RATE_THRESHOLD_PERCENT) {
      alerts.push({
        id: 'webhook-failure-rate-high', severity: 'warning', category: 'Integrations',
        message: `${wh.failedEvents} of ${wh.totalEvents} subscription-billing webhook events failed to process in this period.`,
        metricValue: wh.failureRatePercent, threshold: `> ${PlatformAlertsService.WEBHOOK_FAILURE_RATE_THRESHOLD_PERCENT}%`,
      });
    }

    // 3. WARNING — real, live BullMQ dead-letter jobs or an unreachable queue.
    for (const q of health.data.queueBacklog) {
      if (q.unavailable) {
        alerts.push({
          id: `queue-unavailable-${q.name}`, severity: 'warning', category: 'Infrastructure',
          message: `${q.name} queue's job counts could not be read right now (its Redis connection was unreachable).`,
          metricValue: 'unavailable', threshold: 'reachable',
        });
      } else if ((q.failed ?? 0) > 0) {
        alerts.push({
          id: `queue-failed-jobs-${q.name}`, severity: 'warning', category: 'Infrastructure',
          message: `${q.name} queue has ${q.failed} job(s) sitting in its dead-letter (failed) state.`,
          metricValue: q.failed ?? 0, threshold: '> 0',
        });
      }
    }

    // 4. WARNING — real payment failure rate, ignoring tiny samples.
    const p = payments.data;
    const totalPayments = p.successfulPayments.count + p.failedPayments.count + p.pendingPayments.count;
    const paymentFailureRatePercent = totalPayments > 0 ? round((p.failedPayments.count / totalPayments) * 100) : 0;
    if (totalPayments >= PlatformAlertsService.PAYMENT_MIN_SAMPLE_SIZE && paymentFailureRatePercent > PlatformAlertsService.PAYMENT_FAILURE_RATE_THRESHOLD_PERCENT) {
      alerts.push({
        id: 'payment-failure-rate-high', severity: 'warning', category: 'Payments',
        message: `${p.failedPayments.count} of ${totalPayments} payments failed in this period.`,
        metricValue: paymentFailureRatePercent, threshold: `> ${PlatformAlertsService.PAYMENT_FAILURE_RATE_THRESHOLD_PERCENT}%`,
      });
    }

    // 5. WARNING — real refund rate (USD-normalized gross vs. refunds — see Phase 0/2).
    if (overview.data.refundRatePercent > PlatformAlertsService.REFUND_RATE_THRESHOLD_PERCENT) {
      alerts.push({
        id: 'refund-rate-high', severity: 'warning', category: 'Revenue',
        message: `Refund rate is ${overview.data.refundRatePercent}% of gross revenue in this period.`,
        metricValue: overview.data.refundRatePercent, threshold: `> ${PlatformAlertsService.REFUND_RATE_THRESHOLD_PERCENT}%`,
      });
    }

    // 6. INFO — real, date-derived seller sales-recency status counts (see deriveSellerSalesStatus).
    if (sellerStatusCounts.dormant > 0) {
      alerts.push({
        id: 'sellers-dormant', severity: 'info', category: 'Sellers',
        message: `${sellerStatusCounts.dormant} seller(s) are dormant (no order in over 90 days, or never sold and registered over 30 days ago).`,
        metricValue: sellerStatusCounts.dormant, threshold: '> 0',
      });
    }
    if (sellerStatusCounts.atRisk > 0) {
      alerts.push({
        id: 'sellers-at-risk', severity: 'info', category: 'Sellers',
        message: `${sellerStatusCounts.atRisk} seller(s) are at risk (last order 31–90 days ago).`,
        metricValue: sellerStatusCounts.atRisk, threshold: '> 0',
      });
    }

    // 7. INFO — real out-of-stock count (see getInventoryInsights).
    if (inventory.data.outOfStockCount > 0) {
      alerts.push({
        id: 'products-out-of-stock', severity: 'info', category: 'Inventory',
        message: `${inventory.data.outOfStockCount} active product(s) are out of stock.`,
        metricValue: inventory.data.outOfStockCount, threshold: '> 0',
      });
    }

    alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    return {
      success: true,
      data: {
        alerts,
        note:
          'Every alert above is a fixed, documented threshold check against real data already computed elsewhere in this dashboard — dependency health, webhook/payment/refund rates, seller sales-recency status, and inventory. None of it is AI-generated, a learned/tuned anomaly score, or a subjective judgment call; the thresholds are hardcoded constants in PlatformAlertsService, not derived from the data itself.',
      },
    };
  }
}
