/* eslint-disable prettier/prettier */
import { ActivationFunnelService } from './activation-funnel.service';

const q = (rows: any) => { const p: any = Promise.resolve(rows); p.select = () => p; p.lean = () => p; return p; };
const NOW = new Date('2026-10-30T12:00:00Z').getTime();

describe('ActivationFunnelService', () => {
  it('takes the earliest date across a seller\'s stores and finds the first paid plan', async () => {
    const r: any = {
      sellerModel: { find: jest.fn(() => q([
        { _id: 'se1', name: 'Ana', email: 'ana@x.test', isVerified: true, acquisitionSource: 'google', createdAt: new Date('2026-10-01T00:00:00Z') },
        { _id: 'se2', name: 'Bo', email: 'bo@x.test', isVerified: true, acquisitionSource: null, createdAt: new Date('2026-10-20T00:00:00Z') },
      ])) },
      storeModel: { find: jest.fn(() => q([
        { _id: 'st1', sellerId: 'se1', createdAt: new Date('2026-10-02T00:00:00Z') },
        { _id: 'st2', sellerId: 'se1', createdAt: new Date('2026-10-09T00:00:00Z') },
        { _id: 'st3', sellerId: 'se2', createdAt: new Date('2026-10-21T00:00:00Z') },
      ])) },
      productModel: { aggregate: jest.fn(async () => [{ _id: 'st2', at: new Date('2026-10-10T00:00:00Z') }, { _id: 'st1', at: new Date('2026-10-04T00:00:00Z') }]) },
      orderModel: { aggregate: jest.fn(async () => [{ _id: 'st2', at: new Date('2026-10-12T00:00:00Z') }]) },
      sellerPlatformSubscriptionModel: { find: jest.fn(() => q([
        { storeId: 'st1', status: 'active', platformPlanId: 'basic', amountUSD: 29, billingInterval: 'monthly', startedAt: new Date('2026-10-02T00:00:00Z'), trialEndsAt: new Date('2026-10-16T00:00:00Z'),
          planHistory: [{ fromPlanId: null, toPlanId: 'basic', changedAt: new Date('2026-10-14T00:00:00Z') }] },
        { storeId: 'st3', status: 'trialing', platformPlanId: null, amountUSD: 0, startedAt: new Date('2026-10-21T00:00:00Z'), trialEndsAt: new Date('2026-11-04T00:00:00Z'), planHistory: [] },
      ])) },
      platformPlanModel: { find: jest.fn(() => q([{ _id: 'basic', monthlyPriceUSD: 29 }])) },
    };
    const { data } = await new ActivationFunnelService({ repositories: r } as any).getFunnel(2, NOW);
    expect(data.steps.map((s: any) => [s.step, s.merchants])).toEqual([['signed_up', 2], ['verified', 2], ['store', 2], ['product', 1], ['sale', 1], ['paying', 1]]);
    expect(data.steps.find((s: any) => s.step === 'product')?.medianDaysFromSignup).toBe(3); // st1's Oct 4, not st2's Oct 10
    expect(data.byCohort.map((c: any) => c.month)).toEqual(['2026-09', '2026-10']);
    expect(data.stuck).toEqual([expect.objectContaining({ sellerId: 'se2', stuckAt: 'store', nextStep: 'product', daysStuck: 9 })]);
    expect(r.sellerModel.find).toHaveBeenCalledWith({ isDelete: { $ne: true }, createdAt: { $gte: new Date('2026-09-01T00:00:00Z') } });
  });
});
