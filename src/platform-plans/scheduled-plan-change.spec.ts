/* eslint-disable prettier/prettier */
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';
import { PLAN_CATALOG, YEARLY_DISCOUNT, assertCatalogValid, yearlyPriceFor } from './platform-plan.catalog';

describe('platform plan catalog — uniform yearly discount (Shopify: 25% off)', () => {
  it('every self-serve plan uses the same yearly discount', () => {
    for (const p of PLAN_CATALOG) {
      expect(p.yearlyPriceUSD).toBe(yearlyPriceFor(p.monthlyPriceUSD as number));
      const discount = 1 - (p.yearlyPriceUSD as number) / ((p.monthlyPriceUSD as number) * 12);
      expect(Math.abs(discount - YEARLY_DISCOUNT)).toBeLessThan(0.01);
    }
  });

  it('the shipped catalog is valid, and a non-uniform yearly price is rejected', () => {
    expect(() => assertCatalogValid()).not.toThrow();
    const bad = PLAN_CATALOG.map(p => (p.key === 'grow' ? { ...p, yearlyPriceUSD: 792 } : p));
    expect(() => assertCatalogValid(bad)).toThrow(/yearly/i);
  });

  it('Basic/Grow limits are the Shopify-shaped ones (no 0-product / 0-staff plans)', () => {
    const basic = PLAN_CATALOG.find(p => p.key === 'basic')!;
    const grow = PLAN_CATALOG.find(p => p.key === 'grow')!;
    expect(basic.limits.maxProducts).toBeGreaterThan(0);
    expect(basic.limits.maxStaffAccounts).toBeGreaterThanOrEqual(1);
    expect(grow.limits.maxProducts).toBe(-1);
    expect(grow.limits.maxStaffAccounts).toBe(5);
  });
});

describe('SellerPlatformSubscriptionsService — end-of-cycle downgrade (Shopify pre-paid plans)', () => {
  const future = new Date(Date.now() + 10 * 24 * 3600 * 1000);
  const active = (over: Record<string, any> = {}) => ({
    status: 'active', platformPlanId: 'plan-grow', amountUSD: 49, cancelAtPeriodEnd: false, currentPeriodEnd: future, ...over,
  });
  const svc = () => {
    const planModel = { findById: jest.fn(), findOne: jest.fn() };
    const activity = { log: jest.fn() };
    const service: any = new SellerPlatformSubscriptionsService(
      { repositories: { platformPlanModel: planModel, storeModel: { findById: jest.fn().mockResolvedValue(null) } } } as any,
      { isProviderDrivenBilling: false } as any, activity as any, {} as any, {} as any, {} as any, {} as any,
    );
    return { service, planModel, activity };
  };

  it('a cheaper plan on an active paid subscription is deferred', () => {
    const { service } = svc();
    expect(service.isDeferredDowngrade(active(), { isFree: false }, 10)).toBe(true);
  });

  it('upgrades, trials, locked/past-due stores and pending cancellations switch immediately', () => {
    const { service } = svc();
    expect(service.isDeferredDowngrade(active(), { isFree: false }, 99)).toBe(false);
    expect(service.isDeferredDowngrade(active({ status: 'trialing', platformPlanId: null }), { isFree: false }, 10)).toBe(false);
    expect(service.isDeferredDowngrade(active({ status: 'past_due' }), { isFree: false }, 10)).toBe(false);
    expect(service.isDeferredDowngrade(active({ status: 'locked' }), { isFree: false }, 10)).toBe(false);
    expect(service.isDeferredDowngrade(active({ cancelAtPeriodEnd: true }), { isFree: false }, 10)).toBe(false);
    expect(service.isDeferredDowngrade(active({ currentPeriodEnd: new Date(Date.now() - 1000) }), { isFree: false }, 10)).toBe(false);
  });

  it('applyScheduledPlanChange moves the subscription to the scheduled plan and clears the schedule', async () => {
    const { service, planModel, activity } = svc();
    planModel.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ name: 'Grow' }) }) });
    planModel.findOne.mockResolvedValue({ _id: 'plan-basic', name: 'Basic', monthlyPriceUSD: 10, yearlyPriceUSD: 90, limits: {} });
    const sub: any = active({ _id: 's1', storeId: 'st1', billingInterval: 'monthly', planHistory: [], scheduledPlanChange: { planId: 'plan-basic', planName: 'Basic', interval: 'monthly', amountUSD: 10, scheduledAt: new Date() } });
    expect(await service.applyScheduledPlanChange(sub)).toBe(true);
    expect(sub.platformPlanId).toBe('plan-basic');
    expect(sub.amountUSD).toBe(10);
    expect(sub.scheduledPlanChange).toBeNull();
    expect(sub.planHistory).toHaveLength(1);
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'scheduled_plan_change_applied' }));
  });

  it('drops the schedule (keeps the current plan) when the target plan no longer exists', async () => {
    const { service, planModel } = svc();
    planModel.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ name: 'Grow' }) }) });
    planModel.findOne.mockResolvedValue(null);
    const sub: any = active({ storeId: 'st1', planHistory: [], scheduledPlanChange: { planId: 'gone', planName: 'X', interval: 'monthly', amountUSD: 10, scheduledAt: new Date() } });
    expect(await service.applyScheduledPlanChange(sub)).toBe(false);
    expect(sub.platformPlanId).toBe('plan-grow');
    expect(sub.scheduledPlanChange).toBeNull();
  });
});
