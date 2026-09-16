/* eslint-disable prettier/prettier */
import { PlatformPlansService } from './platform-plans.service';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';

// Phase 1 — this file previously had zero tests. Focus: adminGetRevenue's
// existing MRR/ARR computation (unchanged) and the NEW seller-churn
// computation added for Owner Analytics Overview — in particular that it
// uses the exact, real `canceledAt` timestamp (never a startedAt-based
// proxy) and never divides by zero.

function leanAll<T>(value: T[]) {
  return jest.fn().mockResolvedValue(value);
}

describe('PlatformPlansService.adminGetRevenue — seller churn', () => {
  let service: PlatformPlansService;
  let subModel: any;
  let planModel: any;
  let planInvoiceModel: any;
  let storeModel: any;

  function setup(opts: {
    activeAtPeriodStartCount?: number;
    canceledInPeriodCount?: number;
    activeSubs?: any[];
  } = {}) {
    subModel = {
      aggregate: leanAll([]),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(opts.activeSubs ?? []) }) }),
      countDocuments: jest.fn()
        .mockResolvedValueOnce(0) // activeSubscribersCount (called before the churn queries in source order)
        .mockResolvedValueOnce(opts.activeAtPeriodStartCount ?? 0)
        .mockResolvedValueOnce(opts.canceledInPeriodCount ?? 0),
    };
    planModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    planInvoiceModel = { aggregate: leanAll([]) };
    storeModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };

    const db = {
      repositories: {
        sellerPlatformSubscriptionModel: subModel,
        platformPlanModel: planModel,
        platformPlanInvoiceModel: planInvoiceModel,
        storeModel,
        platformTrialSettingsModel: {},
      },
    } as unknown as DatabaseService;

    const activityLogService = {} as ActivityLogService;
    service = new PlatformPlansService(db, activityLogService);
  }

  it('computes churnRatePercent as canceledInPeriod / activeAtPeriodStart * 100', async () => {
    setup({ activeAtPeriodStartCount: 40, canceledInPeriodCount: 2 });
    const result = await service.adminGetRevenue({ from: '2026-01-01', to: '2026-01-31' });
    expect(result.data.activeAtPeriodStart).toBe(40);
    expect(result.data.canceledInPeriod).toBe(2);
    expect(result.data.churnRatePercent).toBe(5);
  });

  it('returns 0 (never divides by zero / never fabricates) when nothing was active at period start', async () => {
    setup({ activeAtPeriodStartCount: 0, canceledInPeriodCount: 0 });
    const result = await service.adminGetRevenue({ from: '2026-01-01', to: '2026-01-31' });
    expect(result.data.churnRatePercent).toBe(0);
  });

  it('queries cancellation by the real canceledAt timestamp within [from, to], not a derived/inferred window', async () => {
    setup({ activeAtPeriodStartCount: 10, canceledInPeriodCount: 1 });
    await service.adminGetRevenue({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' });

    // Second countDocuments call in source order is activeAtPeriodStart, third is canceledInPeriod.
    const canceledCall = subModel.countDocuments.mock.calls[2][0];
    expect(canceledCall.status).toBe('canceled');
    expect(canceledCall.canceledAt.$gte).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(canceledCall.canceledAt.$lte).toEqual(new Date('2026-01-31T00:00:00.000Z'));
  });

  it('excludes pure trials from activeAtPeriodStart (a trial that never converts was never a paying subscriber)', async () => {
    setup({ activeAtPeriodStartCount: 5, canceledInPeriodCount: 0 });
    await service.adminGetRevenue({ from: '2026-01-01', to: '2026-01-31' });

    const activeAtStartCall = subModel.countDocuments.mock.calls[1][0];
    expect(activeAtStartCall.status).toEqual({ $ne: 'trialing' });
  });
});
