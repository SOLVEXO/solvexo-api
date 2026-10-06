import { resolveStorePlanCacheValue, syncStorePlanCache } from './store-plan-sync.util';
import { LegacyPlatformSubscriptionBackfillService } from './legacy-platform-subscription-backfill.service';

describe('resolveStorePlanCacheValue', () => {
  it('trial (no plan) and canceled map to starter', () => {
    expect(resolveStorePlanCacheValue({ platformPlanId: null, status: 'trialing' }, null)).toBe('starter');
    expect(resolveStorePlanCacheValue({ platformPlanId: 'p', status: 'canceled' }, { key: 'grow' })).toBe('starter');
  });
  it('free plan -> starter; catalog key -> key; unknown name -> null (unchanged)', () => {
    expect(resolveStorePlanCacheValue({ platformPlanId: 'p', status: 'active' }, { isFree: true, key: null })).toBe('starter');
    expect(resolveStorePlanCacheValue({ platformPlanId: 'p', status: 'active' }, { key: 'grow', name: 'Growth' })).toBe('grow');
    expect(resolveStorePlanCacheValue({ platformPlanId: 'p', status: 'active' }, { key: null, name: 'Custom Deal' })).toBeNull();
    expect(resolveStorePlanCacheValue({ platformPlanId: 'p', status: 'locked' }, null)).toBeNull();
  });
});

describe('syncStorePlanCache', () => {
  const mk = (modified = 1) => {
    const q: any = Promise.resolve({ modifiedCount: modified }); q.session = jest.fn();
    const storeModel = { updateOne: jest.fn().mockReturnValue(q) };
    const planModel = { findById: jest.fn().mockReturnValue({ select: () => ({ lean: async () => ({ key: 'advanced' }) }) }) };
    return { storeModel, planModel };
  };
  it('writes conditionally ($ne) so it is idempotent', async () => {
    const m = mk();
    expect(await syncStorePlanCache(m, { storeId: 's1', platformPlanId: 'p', status: 'active' })).toBe(true);
    expect(m.storeModel.updateOne).toHaveBeenCalledWith({ _id: 's1', plan: { $ne: 'advanced' } }, { $set: { plan: 'advanced' } });
  });
  it('reports false when nothing changed, and never throws', async () => {
    expect(await syncStorePlanCache(mk(0), { storeId: 's1', platformPlanId: 'p', status: 'active' })).toBe(false);
    expect(await syncStorePlanCache({ storeModel: null, planModel: null }, { storeId: 's', platformPlanId: 'p' })).toBe(false);
  });
});

describe('LegacyPlatformSubscriptionBackfillService', () => {
  it('lists legacy subs lacking a SellerPlatformSubscription, creating nothing', async () => {
    const lean = (v: any) => ({ select: () => ({ lean: async () => v }) });
    const svc = new LegacyPlatformSubscriptionBackfillService({
      repositories: {
        platformSubscriptionModel: { find: () => lean([{ storeId: 'a', tier: 'pro', status: 'active' }, { storeId: 'b', tier: 'basic', status: 'active' }]) },
        sellerPlatformSubscriptionModel: { find: () => lean([{ storeId: 'b' }]) },
      },
    } as any);
    expect(await svc.reportOrphanedLegacySubscriptions()).toEqual([{ storeId: 'a', tier: 'pro', status: 'active' }]);
  });
});
