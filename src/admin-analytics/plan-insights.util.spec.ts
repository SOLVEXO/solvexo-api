/* eslint-disable prettier/prettier */
import { type InsightSub, type PlanRecord, buildPlanInsights, planMoves } from './plan-insights.util';
import { monthKey, monthPoints } from './saas-metrics.util';

const plans: PlanRecord[] = [
  { _id: 'free', name: 'Free', isFree: true, limits: { maxProducts: 10, transactionFeeRate: 0.03 } },
  { _id: 'basic', name: 'Basic', monthlyPriceUSD: 29, yearlyPriceUSD: 290, limits: { maxProducts: 100, transactionFeeRate: 0.02 } },
  { _id: 'pro', name: 'Pro', monthlyPriceUSD: 79, yearlyPriceUSD: 790, limits: { maxProducts: -1, transactionFeeRate: 0.01 } },
  { _id: 'old', name: 'Legacy', status: 'archived', monthlyPriceUSD: 9 },
];
const now = Date.parse('2026-10-15T12:00:00Z');
const from = Date.parse('2025-11-01T00:00:00Z');
const base = { billingInterval: 'monthly', trialEndsAt: null };
const subs: InsightSub[] = [
  // Trial in January, bought Basic, upgraded to Pro in April.
  { ...base, storeId: 'A', status: 'active', platformPlanId: 'pro', amountUSD: 79, startedAt: '2026-01-01', trialEndsAt: '2026-01-15', planHistory: [
    { fromPlanId: null, toPlanId: 'basic', changedAt: '2026-01-10', amountUSD: 29, interval: 'monthly' },
    { fromPlanId: 'basic', toPlanId: 'pro', changedAt: '2026-04-02', amountUSD: 79, interval: 'monthly' },
  ] },
  // On an older $19 Basic price, cancelling at period end, near the product limit.
  { ...base, storeId: 'B', status: 'active', platformPlanId: 'basic', amountUSD: 19, startedAt: '2025-06-01', cancelAtPeriodEnd: true },
  // Pro yearly with a downgrade to Basic monthly booked for renewal.
  { ...base, storeId: 'C', status: 'active', platformPlanId: 'pro', amountUSD: 790, billingInterval: 'yearly', startedAt: '2025-03-01',
    scheduledPlanChange: { planId: 'basic', interval: 'monthly', amountUSD: 29 } },
  // Pro since 2025, downgraded to Basic in August.
  { ...base, storeId: 'D', status: 'active', platformPlanId: 'basic', amountUSD: 29, startedAt: '2025-02-01', planHistory: [
    { fromPlanId: null, toPlanId: 'pro', changedAt: '2025-02-01', amountUSD: 79, interval: 'monthly' },
    { fromPlanId: 'pro', toPlanId: 'basic', changedAt: '2026-08-05', amountUSD: 29, interval: 'monthly' },
  ] },
  // Paid Basic, canceled in March.
  { ...base, storeId: 'E', status: 'canceled', platformPlanId: 'basic', amountUSD: 29, startedAt: '2025-01-01', canceledAt: '2026-03-01' },
  { ...base, storeId: 'F', status: 'trialing', platformPlanId: null, amountUSD: 0, startedAt: '2026-10-10', trialEndsAt: '2026-10-24' },
  // Free plan, 9 of 10 products.
  { ...base, storeId: 'G', status: 'active', platformPlanId: 'free', amountUSD: 0, startedAt: '2025-01-01' },
];
const run = () => buildPlanInsights({
  subs, plans, from, now, months: monthPoints(12, now).map(monthKey), productCounts: new Map([['B', 90], ['G', 9], ['D', 10]]),
});
const plan = (out: ReturnType<typeof run>, id: string) => out.plans.find((p) => p.planId === id)!;

describe('planMoves', () => {
  it('classifies first purchase, upgrade and downgrade by monthly price', () => {
    const planMap = new Map(plans.map((p) => [p._id, p]));
    expect(planMoves(subs[0], planMap).map((m) => [m.kind, m.fromMrr, m.toMrr])).toEqual([['new', 0, 29], ['upgrade', 29, 79]]);
    expect(planMoves(subs[3], planMap).map((m) => m.kind)).toEqual(['new', 'downgrade']);
  });
});

describe('buildPlanInsights', () => {
  it('summarises MRR, moves and risks across plans', () => {
    const s = run().summary;
    expect(s).toMatchObject({
      mrr: 192.83, payingStores: 4, trialingStores: 1, freePlanStores: 1, yearlySharePercent: 25,
      newStores: 1, newMrr: 29, upgrades: 1, upgradeMrr: 50, downgrades: 1, downgradeMrr: 50, upgradeToDowngradeRatio: 1,
      belowListStores: 1, belowListGapMrr: 10, cancelingStores: 1, cancelingMrr: 19,
      scheduledDowngrades: 1, scheduledDowngradeMrr: 36.83, outgrowingStores: 2, upgradeOpportunityMrr: 89,
    });
  });

  it('gives each plan its subscribers, price gaps, moves and who stopped paying', () => {
    const out = run();
    expect(plan(out, 'basic')).toMatchObject({
      stores: 2, payingStores: 2, mrr: 48, arpu: 24, yearlyDiscountPercent: 16.67, transactionFeePercent: 2,
      belowListStores: 1, newStores: 1, upgradesOut: 1, downgradesIn: 1, payingAtStart: 2, stoppedPaying: 1, stoppedPayingPercent: 50,
    });
    expect(plan(out, 'pro')).toMatchObject({ payingStores: 2, yearlyStores: 1, mrr: 144.83, upgradesIn: 1, downgradesOut: 1, payingAtStart: 2, stoppedPaying: 0 });
    expect(out.plans.map((p) => p.planId)).toEqual(['basic', 'pro', 'free']); // archived plan with no stores is left out
  });

  it('lists moves between plans and the month they happened', () => {
    const out = run();
    expect(out.moves.map((m) => [m.fromName, m.toName, m.kind, m.mrrChange])).toEqual([['Basic', 'Pro', 'upgrade', 50], ['Pro', 'Basic', 'downgrade', -50]]);
    const m = (k: string) => out.monthly.find((x) => x.month === k)!;
    expect(m('2026-01')).toMatchObject({ new: 1, newMrr: 29 });
    expect(m('2026-04')).toMatchObject({ upgrades: 1, upgradeMrr: 50 });
    expect(m('2026-08')).toMatchObject({ downgrades: 1, downgradeMrr: 50 });
  });

  it('flags stores near their product limit with the next plan that fits', () => {
    expect(run().candidates.map((c) => [c.storeId, c.usagePercent, c.suggestedPlanName, c.mrrIfUpgraded, c.currentMrr])).toEqual([
      ['B', 90, 'Pro', 79, 19], ['G', 90, 'Basic', 29, 0],
    ]);
  });
});
