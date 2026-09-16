/* eslint-disable prettier/prettier */
import { PlatformAlertsService } from './platform-alerts.service';
import { DatabaseService } from '../database/databaseservice';
import { AdminAnalyticsService } from '../admin-analytics/admin-analytics.service';
import { PlatformHealthService } from '../platform-health/platform-health.service';

// Phase 11 — Alerts & Insights. Standing rule under test: deterministic
// threshold rules ONLY, no AI-generated insights — every case here proves
// a specific hardcoded threshold fires (or doesn't) against a specific
// real input, never a fuzzy/learned judgment.

function baseHealth(overrides: Partial<any> = {}) {
  return {
    success: true,
    data: {
      dependencyStatus: { mongodb: 'up', redis: 'up', checkedAt: new Date() },
      webhookReliability: { totalEvents: 0, failedEvents: 0, failureRatePercent: 0, byStatus: [], note: '' },
      queueBacklog: [],
      note: '',
      ...overrides,
    },
  };
}

function basePayments(overrides: Partial<any> = {}) {
  return {
    success: true,
    data: {
      successfulPayments: { count: 0, amount: 0, unconvertibleCount: 0 },
      failedPayments: { count: 0, amount: 0, unconvertibleCount: 0 },
      pendingPayments: { count: 0, amount: 0, unconvertibleCount: 0 },
      methodBreakdown: [],
      note: '',
      ...overrides,
    },
  };
}

function baseOverview(refundRatePercent = 0) {
  return { success: true, data: { refundRatePercent } };
}

function baseInventory(outOfStockCount = 0) {
  return { success: true, data: { outOfStockCount } };
}

describe('PlatformAlertsService', () => {
  let service: PlatformAlertsService;
  let sellerModel: any;
  let orderModel: any;
  let db: DatabaseService;
  let adminAnalyticsService: AdminAnalyticsService;
  let platformHealthService: PlatformHealthService;

  beforeEach(() => {
    sellerModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    orderModel = { aggregate: jest.fn().mockResolvedValue([]) };
    db = { repositories: { sellerModel, orderModel } } as any;

    adminAnalyticsService = {
      getPaymentBreakdown: jest.fn().mockResolvedValue(basePayments()),
      getOverview: jest.fn().mockResolvedValue(baseOverview()),
      getInventoryInsights: jest.fn().mockResolvedValue(baseInventory()),
    } as any;

    platformHealthService = {
      getPlatformHealth: jest.fn().mockResolvedValue(baseHealth()),
    } as any;

    service = new PlatformAlertsService(db, adminAnalyticsService, platformHealthService);
  });

  it('produces zero alerts when every real signal is healthy', async () => {
    const result = await service.getAlerts({});
    expect(result.success).toBe(true);
    expect(result.data.alerts).toEqual([]);
  });

  it('fires a critical alert when the real dependency check reports MongoDB down', async () => {
    platformHealthService.getPlatformHealth = jest.fn().mockResolvedValue(
      baseHealth({ dependencyStatus: { mongodb: 'down', redis: 'up', checkedAt: new Date() } }),
    );
    const result = await service.getAlerts({});
    const alert = result.data.alerts.find((a) => a.id === 'dependency-mongodb-down');
    expect(alert?.severity).toBe('critical');
  });

  it('fires a webhook-failure warning only above the fixed threshold AND above the minimum sample size', async () => {
    // Below the minimum sample size (5) — must NOT fire even at 100% failure.
    platformHealthService.getPlatformHealth = jest.fn().mockResolvedValue(
      baseHealth({ webhookReliability: { totalEvents: 2, failedEvents: 2, failureRatePercent: 100, byStatus: [], note: '' } }),
    );
    let result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'webhook-failure-rate-high')).toBeUndefined();

    // Above both the sample-size floor and the rate threshold — must fire.
    platformHealthService.getPlatformHealth = jest.fn().mockResolvedValue(
      baseHealth({ webhookReliability: { totalEvents: 20, failedEvents: 5, failureRatePercent: 25, byStatus: [], note: '' } }),
    );
    result = await service.getAlerts({});
    const alert = result.data.alerts.find((a) => a.id === 'webhook-failure-rate-high');
    expect(alert?.severity).toBe('warning');
    expect(alert?.metricValue).toBe(25);
  });

  it('fires a queue alert for real dead-letter (failed) jobs, and a separate one for an unreachable queue', async () => {
    platformHealthService.getPlatformHealth = jest.fn().mockResolvedValue(
      baseHealth({
        queueBacklog: [
          { name: 'Stripe Webhooks', waiting: 0, active: 0, completed: 10, failed: 3, delayed: 0 },
          { name: 'Notifications', waiting: null, active: null, completed: null, failed: null, delayed: null, unavailable: true },
        ],
      }),
    );
    const result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'queue-failed-jobs-Stripe Webhooks')?.metricValue).toBe(3);
    expect(result.data.alerts.find((a) => a.id === 'queue-unavailable-Notifications')).toBeDefined();
  });

  it('fires a payment-failure-rate warning only above both the sample floor and the threshold', async () => {
    adminAnalyticsService.getPaymentBreakdown = jest.fn().mockResolvedValue(
      basePayments({ successfulPayments: { count: 3, amount: 0, unconvertibleCount: 0 }, failedPayments: { count: 2, amount: 0, unconvertibleCount: 0 } }),
    );
    // total = 5, below PAYMENT_MIN_SAMPLE_SIZE (10) — must not fire.
    let result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'payment-failure-rate-high')).toBeUndefined();

    adminAnalyticsService.getPaymentBreakdown = jest.fn().mockResolvedValue(
      basePayments({ successfulPayments: { count: 8, amount: 0, unconvertibleCount: 0 }, failedPayments: { count: 2, amount: 0, unconvertibleCount: 0 } }),
    );
    // total = 10, failure rate 20% > 10% threshold — must fire.
    result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'payment-failure-rate-high')?.metricValue).toBe(20);
  });

  it('fires a refund-rate warning only strictly above the fixed 15% threshold', async () => {
    adminAnalyticsService.getOverview = jest.fn().mockResolvedValue(baseOverview(15));
    let result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'refund-rate-high')).toBeUndefined(); // exactly at threshold — not above it

    adminAnalyticsService.getOverview = jest.fn().mockResolvedValue(baseOverview(16));
    result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'refund-rate-high')?.metricValue).toBe(16);
  });

  it('tallies real, date-derived dormant/at-risk seller counts and raises info alerts for both', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    jest.useFakeTimers().setSystemTime(now);

    sellerModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'seller-dormant', createdAt: new Date('2025-01-01') },
          { _id: 'seller-at-risk', createdAt: new Date('2025-01-01') },
          { _id: 'seller-active', createdAt: new Date('2025-01-01') },
        ]),
      }),
    });
    orderModel.aggregate.mockResolvedValue([
      { _id: 'seller-at-risk', firstOrderAt: new Date('2025-02-01'), lastOrderAt: new Date('2026-04-01'), totalOrders: 5 }, // ~61 days ago → at_risk
      { _id: 'seller-active', firstOrderAt: new Date('2025-02-01'), lastOrderAt: new Date('2026-05-25'), totalOrders: 9 }, // ~7 days ago → active
      // seller-dormant has no order rows at all, and is registered long ago → dormant
    ]);

    const result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'sellers-dormant')?.metricValue).toBe(1);
    expect(result.data.alerts.find((a) => a.id === 'sellers-at-risk')?.metricValue).toBe(1);
    expect(result.data.alerts.find((a) => a.id === 'sellers-active')).toBeUndefined(); // active sellers are never alert-worthy

    jest.useRealTimers();
  });

  it('fires an out-of-stock info alert from the real inventory-insights count', async () => {
    adminAnalyticsService.getInventoryInsights = jest.fn().mockResolvedValue(baseInventory(4));
    const result = await service.getAlerts({});
    expect(result.data.alerts.find((a) => a.id === 'products-out-of-stock')?.metricValue).toBe(4);
  });

  it('sorts alerts critical → warning → info', async () => {
    platformHealthService.getPlatformHealth = jest.fn().mockResolvedValue(
      baseHealth({
        dependencyStatus: { mongodb: 'down', redis: 'up', checkedAt: new Date() },
        webhookReliability: { totalEvents: 20, failedEvents: 10, failureRatePercent: 50, byStatus: [], note: '' },
      }),
    );
    adminAnalyticsService.getInventoryInsights = jest.fn().mockResolvedValue(baseInventory(1));

    const result = await service.getAlerts({});
    const severities = result.data.alerts.map((a) => a.severity);
    const firstWarningIndex = severities.indexOf('warning');
    const firstInfoIndex = severities.indexOf('info');
    expect(severities[0]).toBe('critical');
    if (firstWarningIndex !== -1 && firstInfoIndex !== -1) expect(firstWarningIndex).toBeLessThan(firstInfoIndex);
  });

  it('discloses that alerts are deterministic thresholds, never AI-generated', async () => {
    const result = await service.getAlerts({});
    expect(result.data.note).toContain('hardcoded constants');
    expect(result.data.note).toMatch(/AI-generated/i);
  });
});
