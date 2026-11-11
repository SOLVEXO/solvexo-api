/* eslint-disable prettier/prettier */
import { PLAN_CATALOG, CATALOG_VERSION, assertCatalogValid, buildFeatureBullets } from './platform-plan.catalog';
import { EntitlementsService } from './entitlements.service';

// The final plan matrix (catalog v5). Plain describe/it/expect only, so it also runs on scripts/mini-jest.cjs.
const KEYS = ['basic', 'grow', 'advanced', 'enterprise'];
const limitsOf = (key: string): any => (PLAN_CATALOG.find((p) => p.key === key) as any).limits;
const column = (field: string) => KEYS.map((k) => limitsOf(k)[field]);

/** An EntitlementsService over hand-made models: one active subscription on a plan with exactly these limits. */
function service(limits: any, emailsUsed = 0) {
  const sub = { storeId: 's1', status: 'active', platformPlanId: 'p1', isDelete: false };
  const db: any = {
    repositories: {
      sellerPlatformSubscriptionModel: { findOne: () => ({ lean: async () => sub }) },
      platformPlanModel: {
        findById: () => ({ lean: async () => ({ _id: 'p1', name: 'Test', limits }) }),
        findOne: () => ({ lean: async () => null }),
        find: () => ({ sort: () => ({ lean: async () => [] }) }),
      },
      emailCampaignSendModel: { countDocuments: async () => emailsUsed },
    },
  };
  return new EntitlementsService(db);
}

describe('plan catalog v5 — the final matrix', () => {
  it('is internally valid (limits, tier order, prices) and is version 5', () => {
    expect(CATALOG_VERSION).toBe(5);
    expect(() => assertCatalogValid()).not.toThrow();
  });

  it('limits grow with the tier', () => {
    expect(column('maxProducts')).toEqual([25, -1, -1, -1]);
    expect(column('maxStaffAccounts')).toEqual([1, 5, 15, -1]);
    expect(column('maxPosLocations')).toEqual([1, 3, 10, -1]);
    expect(column('maxMarkets')).toEqual([3, 5, 10, -1]);
    expect(column('aiCreditsPerMonth')).toEqual([100, 500, 2000, 10000]);
    expect(column('transactionFeeRate')).toEqual([0.02, 0.01, 0.006, 0.002]);
    expect(column('monthlyEmailSends')).toEqual([2000, 10000, 50000, 200000]);
    expect(column('maxB2BCatalogs')).toEqual([1, 3, 10, -1]);
  });

  it('abandoned cart, custom redirects, email campaigns, B2B and custom domain are on every plan', () => {
    for (const f of ['abandonedCartRecoveryAllowed', 'customRedirectsAllowed', 'emailCampaignsAllowed', 'b2bWholesaleAllowed', 'customDomainAllowed', 'advancedSeoToolsAllowed']) {
      expect(column(f)).toEqual([true, true, true, true]);
    }
  });

  it('memberships, license keys, courses, loyalty, AI SEO and priority support start at Grow', () => {
    for (const f of ['digitalMembershipsAllowed', 'digitalLicensesAllowed', 'digitalCoursesAllowed', 'loyaltyProgramAllowed', 'seoAiSuggestionsAllowed', 'prioritySupport']) {
      expect(column(f)).toEqual([false, true, true, true]);
    }
  });

  it('API & webhooks, white-label, Search Console and live courier rates start at Advanced; the account manager is Enterprise only', () => {
    for (const f of ['apiWebhooksAllowed', 'whiteLabelAllowed', 'searchConsoleIntegrationAllowed', 'calculatedShippingRatesAllowed']) {
      expect(column(f)).toEqual([false, false, true, true]);
    }
    expect(column('dedicatedAccountManager')).toEqual([false, false, false, true]);
  });

  it('what has nothing behind it is off everywhere', () => {
    expect(column('advancedAnalyticsAllowed')).toEqual([false, false, false, false]);
    expect(column('marketplaceFeaturedBadge')).toEqual([false, false, false, false]);
    expect(column('slaUptimePercent')).toEqual([null, null, null, null]);
  });

  it('store banners and promotions are dead: unlimited on every plan and never advertised', () => {
    expect(column('maxActiveStoreBanners')).toEqual([-1, -1, -1, -1]);
    expect(column('maxActivePromotions')).toEqual([-1, -1, -1, -1]);
    KEYS.forEach((k, i) => {
      const plan: any = PLAN_CATALOG.find((p) => p.key === k);
      const prev: any = i > 0 ? PLAN_CATALOG.find((p) => p.key === KEYS[i - 1]) : null;
      const text = buildFeatureBullets(plan, prev).join(' | ');
      expect(/banner|promotion/i.test(text)).toBe(false);
    });
  });

  it('the marketing bullets mention the monthly emails and the wholesale catalogs', () => {
    const basic: any = PLAN_CATALOG[0];
    const text = buildFeatureBullets(basic, null).join(' | ');
    expect(text.includes('2,000 marketing emails a month')).toBe(true);
    expect(text.includes('1 wholesale catalog')).toBe(true);
  });
});

describe('EntitlementsService — the new limits', () => {
  it('an old plan document without the new fields keeps generous defaults instead of losing features', async () => {
    const limits: any = await service({ maxProducts: 10, maxStaffAccounts: 1, maxPosLocations: 1, transactionFeeRate: 0.02 }).getLimits('s1');
    expect(limits.digitalCoursesAllowed).toBe(true);
    expect(limits.maxB2BCatalogs).toBe(-1);
    expect(limits.monthlyEmailSends).toBe(10000);
  });

  it('refuses a campaign that would pass the monthly email allowance, and says how many are left', async () => {
    const s = service({ monthlyEmailSends: 2000 }, 1900);
    await expect(s.assertEmailAllowance('s1', 200)).rejects.toThrow('100 left this month');
  });

  it('lets a campaign through while it fits, including exactly using up the allowance', async () => {
    const s = service({ monthlyEmailSends: 2000 }, 1000);
    await s.assertEmailAllowance('s1', 200);
    await s.assertEmailAllowance('s1', 1000);
    expect(true).toBe(true);
  });

  it('the wholesale catalog limit blocks the next one and unlimited never does', async () => {
    await expect(service({ maxB2BCatalogs: 1 }).assertCanCreateB2BCatalog('s1', 1)).rejects.toThrow('1 wholesale catalog');
    await service({ maxB2BCatalogs: 3 }).assertCanCreateB2BCatalog('s1', 2);
    await service({ maxB2BCatalogs: -1 }).assertCanCreateB2BCatalog('s1', 500);
    expect(true).toBe(true);
  });
});
