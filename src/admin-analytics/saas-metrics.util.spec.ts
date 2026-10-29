/* eslint-disable prettier/prettier */
import {
  type PlanInfo, type SubRow, cohorts, firstPaidAt, lifetimeValue, liveMrrMap, monthPoints, movementBetween,
  reconstructMrrMapAt, reconstructStoreMrrAt, trialFunnel,
} from './saas-metrics.util';

const D = (s: string) => new Date(`${s}T12:00:00Z`).getTime();
const plans = new Map<string, PlanInfo>([
  ['free', { isFree: true, monthlyPriceUSD: 0 }],
  ['basic', { monthlyPriceUSD: 29, yearlyPriceUSD: 290, gracePeriodDays: 7 }],
  ['pro', { monthlyPriceUSD: 79, yearlyPriceUSD: 790, gracePeriodDays: 7 }],
]);
const sub = (o: Partial<SubRow>): SubRow => ({
  storeId: 's', status: 'active', platformPlanId: 'basic', amountUSD: 29, billingInterval: 'monthly',
  startedAt: '2026-01-05T00:00:00Z', trialEndsAt: null, planHistory: [], ...o,
});

describe('saas metrics — MRR of one store over time', () => {
  // Trialed in January, bought Basic on Jan 10, upgraded to Pro (yearly, $790) on Apr 2.
  const upgrader = sub({
    storeId: 'up', platformPlanId: 'pro', amountUSD: 790, billingInterval: 'yearly', trialEndsAt: '2026-01-19T00:00:00Z',
    planHistory: [
      { fromPlanId: null, toPlanId: 'basic', changedAt: '2026-01-10T00:00:00Z', amountUSD: 29, interval: 'monthly' },
      { fromPlanId: 'basic', toPlanId: 'pro', changedAt: '2026-04-02T00:00:00Z' },
    ],
  });

  it('is 0 during the trial, the recorded price after buying, and the exact current amount (yearly / 12) now', () => {
    expect(reconstructStoreMrrAt(upgrader, D('2026-01-07'), plans)).toBeNull();
    expect(reconstructStoreMrrAt(upgrader, D('2026-02-01'), plans)).toEqual({ mrr: 29, planId: 'basic' });
    expect(reconstructStoreMrrAt(upgrader, D('2026-05-01'), plans)).toEqual({ mrr: 65.83, planId: 'pro' });
    expect(firstPaidAt(upgrader, plans)).toBe(new Date('2026-01-10T00:00:00Z').getTime());
  });

  it('stops at cancellation and at the lock time (lockedAt, else grace end minus grace days)', () => {
    const canceled = sub({ status: 'canceled', canceledAt: '2026-03-15T00:00:00Z' });
    expect(reconstructStoreMrrAt(canceled, D('2026-03-14'), plans)?.mrr).toBe(29);
    expect(reconstructStoreMrrAt(canceled, D('2026-03-16'), plans)).toBeNull();

    const lockedOld = sub({ status: 'locked', gracePeriodEndsAt: '2026-03-08T00:00:00Z' }); // locked Mar 1
    expect(reconstructStoreMrrAt(lockedOld, D('2026-02-28'), plans)?.mrr).toBe(29);
    expect(reconstructStoreMrrAt(lockedOld, D('2026-03-02'), plans)).toBeNull();
    const lockedNew = sub({ status: 'locked', lockedAt: '2026-02-10T00:00:00Z', gracePeriodEndsAt: '2026-03-08T00:00:00Z' });
    expect(reconstructStoreMrrAt(lockedNew, D('2026-02-11'), plans)).toBeNull();
  });

  it('never counts a trial that ended without buying, or a free plan', () => {
    const neverBought = sub({ status: 'trial_ended', platformPlanId: null, amountUSD: 0, trialEndsAt: '2026-01-19T00:00:00Z' });
    expect(reconstructStoreMrrAt(neverBought, D('2026-01-15'), plans)).toBeNull();
    expect(firstPaidAt(neverBought, plans)).toBeNull();
    expect(reconstructStoreMrrAt(sub({ platformPlanId: 'free', amountUSD: 0 }), D('2026-02-01'), plans)).toBeNull();
  });

  it('rebuilt "now" equals the live MRR the Overview shows', () => {
    const subs = [upgrader, sub({ storeId: 'b' }), sub({ storeId: 'pd', status: 'past_due' }), sub({ storeId: 't', status: 'trialing', trialEndsAt: '2026-12-01T00:00:00Z' })];
    const now = D('2026-10-29');
    expect([...reconstructMrrMapAt(subs, now, plans)]).toEqual([...liveMrrMap(subs)]);
  });
});

describe('saas metrics — movement between two months', () => {
  const m = (entries: Array<[string, number]>) => new Map(entries.map(([id, mrr]) => [id, { mrr, planId: null }]));

  it('splits the change into new / expansion / contraction / churn / reactivation and computes NRR, GRR, quick ratio', () => {
    const start = m([['a', 100], ['b', 50], ['c', 30], ['d', 20]]); // 200
    const end = m([['a', 150], ['b', 40], ['d', 20], ['new1', 25], ['back', 10]]);
    const r = movementBetween(start, end, (id) => id === 'back');
    expect(r).toMatchObject({
      startMrr: 200, endMrr: 245, newMrr: 25, reactivationMrr: 10, expansionMrr: 50, contractionMrr: 10, churnedMrr: 30,
      netNewMrr: 45, newStores: 1, reactivatedStores: 1, churnedStores: 1,
      nrrPercent: 105, grrPercent: 80, logoChurnPercent: 25, revenueChurnPercent: 20, quickRatio: 2.13,
    });
    expect(r.startMrr + r.netNewMrr).toBe(r.endMrr);
  });

  it('returns null ratios instead of dividing by zero', () => {
    const r = movementBetween(new Map(), m([['a', 10]]), () => false);
    expect(r.nrrPercent).toBeNull();
    expect(r.logoChurnPercent).toBeNull();
    expect(r.quickRatio).toBeNull();
  });
});

describe('saas metrics — LTV, cohorts, trials, months', () => {
  it('LTV = ARPU / average monthly logo churn, null with no churn', () => {
    expect(lifetimeValue(50, [{ churnedStores: 1, startStores: 20 }, { churnedStores: 1, startStores: 20 }])).toEqual({ avgMonthlyLogoChurnPercent: 5, ltv: 1000, expectedLifetimeMonths: 20 });
    expect(lifetimeValue(50, [{ churnedStores: 0, startStores: 20 }]).ltv).toBeNull();
  });

  it('cohort retention: stores still paying and their revenue vs their first month', () => {
    const p = (month: string, e: Array<[string, number]>) => ({ month, map: new Map(e.map(([id, mrr]) => [id, { mrr, planId: null }])) });
    const rows = cohorts(new Map([['a', D('2026-01-10')], ['b', D('2026-01-20')]]), [
      p('2026-01', [['a', 10], ['b', 10]]), p('2026-02', [['a', 30]]), p('2026-03', []),
    ]);
    expect(rows).toEqual([{ cohort: '2026-01', stores: 2, startMrr: 20, retention: [
      { month: 0, storesPercent: 100, revenuePercent: 100 }, { month: 1, storesPercent: 50, revenuePercent: 150 }, { month: 2, storesPercent: 0, revenuePercent: 0 },
    ] }]);
  });

  it('trial funnel counts conversions against finished trials only', () => {
    const subs = [
      sub({ storeId: '1', trialEndsAt: '2026-03-15T00:00:00Z', startedAt: '2026-03-01T00:00:00Z', planHistory: [{ fromPlanId: null, toPlanId: 'basic', changedAt: '2026-03-11T00:00:00Z' }] }),
      sub({ storeId: '2', status: 'trial_ended', platformPlanId: null, amountUSD: 0, trialEndsAt: '2026-03-16T00:00:00Z', startedAt: '2026-03-02T00:00:00Z' }),
      sub({ storeId: '3', status: 'trialing', platformPlanId: null, amountUSD: 0, trialEndsAt: '2026-04-20T00:00:00Z', startedAt: '2026-03-30T00:00:00Z' }),
      sub({ storeId: 'legacy', startedAt: '2026-03-05T00:00:00Z' }), // never trialed: not in the funnel
    ];
    expect(trialFunnel(subs, plans, ['2026-03'])).toEqual([{ month: '2026-03', started: 3, converted: 1, stillTrialing: 1, conversionPercent: 50, avgDaysToConvert: 10 }]);
  });

  it('month points end each month and finish at now', () => {
    const pts = monthPoints(3, D('2026-10-29'));
    expect(pts.map((p) => new Date(p).toISOString())).toEqual(['2026-08-31T23:59:59.999Z', '2026-09-30T23:59:59.999Z', new Date(D('2026-10-29')).toISOString()]);
  });
});
