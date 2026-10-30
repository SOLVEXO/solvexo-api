/* eslint-disable prettier/prettier */
import { SaasMetricsService } from './saas-metrics.service';

const q = (rows: any[]) => { const p: any = Promise.resolve(rows); p.select = () => p; p.lean = () => p; p.sort = () => p; return p; };

function build(subs: any[], snapshotRows: any[] = []) {
  const snapshots: any = {
    rows: snapshotRows,
    find: jest.fn((f: any) => q(snapshots.rows.filter((r: any) => f.date.$in.includes(r.date)))),
    findOne: jest.fn(() => q([...snapshots.rows].sort((a: any, b: any) => a.date.localeCompare(b.date))[0] ?? null)),
    updateOne: jest.fn(async (f: any, u: any) => { snapshots.rows = [...snapshots.rows.filter((r: any) => r.date !== f.date), u.$set]; }),
  };
  const db: any = { repositories: {
    sellerPlatformSubscriptionModel: { find: jest.fn(() => q(subs)) },
    platformPlanModel: { find: jest.fn(() => q([{ _id: 'basic', name: 'Basic', monthlyPriceUSD: 30 }, { _id: 'pro', name: 'Pro', monthlyPriceUSD: 100 }])) },
  } };
  const redis: any = { withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) => { await fn(); return 'ok'; }) };
  return { svc: new SaasMetricsService(db, redis, snapshots), snapshots };
}
const NOW = new Date('2026-10-29T12:00:00Z').getTime();
const active = (storeId: string, plan: string, amount: number, startedAt: string) => ({ storeId, status: 'active', platformPlanId: plan, amountUSD: amount, billingInterval: 'monthly', startedAt, trialEndsAt: null, planHistory: [] });

describe('SaasMetricsService', () => {
  it('current month is live and matches the subscriptions; earlier months are rebuilt and labelled so', async () => {
    const { svc } = build([active('a', 'basic', 30, '2026-01-01T00:00:00Z'), active('b', 'pro', 100, '2026-10-05T00:00:00Z')]);
    const { data } = await svc.getMetrics(3, NOW);
    expect(data.current).toMatchObject({ mrr: 130, arr: 1560, payingStores: 2, arpu: 65 });
    expect(data.monthly.map((m: any) => [m.month, m.source, m.mrr])).toEqual([['2026-08', 'reconstructed', 30], ['2026-09', 'reconstructed', 30], ['2026-10', 'live', 130]]);
    expect(data.monthly[2]).toMatchObject({ newMrr: 100, newStores: 1, churnedMrr: 0 });
    expect(data.byPlan).toEqual([{ planId: 'pro', planName: 'Pro', stores: 1, mrr: 100 }, { planId: 'basic', planName: 'Basic', stores: 1, mrr: 30 }]);
    expect(data.dataQuality.reconstructedMonths).toEqual(['2026-08', '2026-09']);
  });

  it('prefers a stored daily snapshot, which can show a lapse the subscription record has forgotten', async () => {
    // Store 'a' looks continuously active on its record, but the Sept 30 snapshot saw it not paying.
    const { svc } = build([active('a', 'basic', 30, '2026-01-01T00:00:00Z')], [{ date: '2026-09-30', stores: [], totalMrr: 0, payingStores: 0 }]);
    const { data } = await svc.getMetrics(3, NOW);
    expect(data.monthly.map((m: any) => m.source)).toEqual(['reconstructed', 'snapshot', 'live']);
    expect(data.monthly[1]).toMatchObject({ month: '2026-09', churnedMrr: 30, churnedStores: 1 });
    expect(data.monthly[2]).toMatchObject({ month: '2026-10', reactivationMrr: 30, reactivatedStores: 1, newMrr: 0 });
    expect(data.dataQuality.firstDailySnapshot).toBe('2026-09-30');
  });

  it('daily snapshot stores each paying store once per day (re-running the same day replaces it)', async () => {
    const { svc, snapshots } = build([active('a', 'basic', 30, '2026-01-01T00:00:00Z'), { ...active('t', 'basic', 0, '2026-10-01T00:00:00Z'), status: 'trialing' }]);
    await svc.captureSnapshot(NOW);
    await svc.captureSnapshot(NOW);
    expect(snapshots.rows).toEqual([{ date: '2026-10-29', stores: [{ storeId: 'a', planId: 'basic', mrr: 30 }], totalMrr: 30, payingStores: 1 }]);
  });

  it('exports the monthly table as CSV', async () => {
    const { svc } = build([active('a', 'basic', 30, '2026-01-01T00:00:00Z')]);
    const csv = await svc.exportCsv(3);
    expect(csv.split('\n')[0]).toMatch(/^month,source,mrr,arr,payingStores,arpu,newMrr/);
    expect(csv.split('\n')).toHaveLength(4);
  });
});
