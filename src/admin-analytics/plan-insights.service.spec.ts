/* eslint-disable prettier/prettier */
import { PlanInsightsService } from './plan-insights.service';

const q = (rows: any) => { const p: any = Promise.resolve(rows); p.select = () => p; p.lean = () => p; return p; };
const NOW = Date.UTC(2026, 9, 30, 12);

describe('PlanInsightsService', () => {
  it('counts products only for limited plans, names the stores and caches per range', async () => {
    const r: any = {
      sellerPlatformSubscriptionModel: { find: jest.fn(() => q([
        { storeId: 'st1', status: 'active', platformPlanId: 'basic', amountUSD: 29, billingInterval: 'monthly', startedAt: '2026-01-01', planHistory: [] },
        { storeId: 'st2', status: 'active', platformPlanId: 'pro', amountUSD: 79, billingInterval: 'monthly', startedAt: '2026-01-01', planHistory: [] },
      ])) },
      platformPlanModel: { find: jest.fn(() => q([
        { _id: 'basic', name: 'Basic', monthlyPriceUSD: 29, limits: { maxProducts: 50 } },
        { _id: 'pro', name: 'Pro', monthlyPriceUSD: 79, limits: { maxProducts: -1 } },
      ])) },
      productModel: { aggregate: jest.fn(async () => [{ _id: 'st1', n: 48 }]) },
      storeModel: { find: jest.fn(() => q([{ _id: 'st1', name: 'Bloom', sellerId: 'se1' }])) },
    };
    const svc = new PlanInsightsService({ repositories: r } as any);
    const { data } = await svc.getInsights(6, NOW);
    expect(r.productModel.aggregate.mock.calls[0][0][0].$match.storeId.$in).toEqual(['st1']);
    expect(data.summary).toMatchObject({ mrr: 108, payingStores: 2, outgrowingStores: 1, upgradeOpportunityMrr: 50 });
    expect(data.candidates[0]).toMatchObject({ storeName: 'Bloom', sellerId: 'se1', suggestedPlanName: 'Pro', usagePercent: 96 });
    expect(data.monthly).toHaveLength(6);
    await svc.getInsights(6, NOW + 1000);
    expect(r.sellerPlatformSubscriptionModel.find).toHaveBeenCalledTimes(1);
  });
});
