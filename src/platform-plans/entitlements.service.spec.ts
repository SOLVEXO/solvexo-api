/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { EntitlementsService } from './entitlements.service';
import { DatabaseService } from '../database/databaseservice';

const STORE_ID = 'store-1';

const PAID_PLAN = {
  _id: 'plan-1',
  name: 'Growth',
  limits: {
    maxProducts: 10, maxStaffAccounts: 2, maxPosLocations: 1, aiCreditsPerMonth: 500,
    transactionFeeRate: 0.03, customDomainAllowed: false, whiteLabelAllowed: false,
    loyaltyProgramAllowed: false, subscriptionProductsAllowed: false, advancedAnalyticsAllowed: false,
    abandonedCartRecoveryAllowed: false, emailCampaignsAllowed: false, apiWebhooksAllowed: false,
    dedicatedAccountManager: false, prioritySupport: false, marketplaceFeaturedBadge: false, slaUptimePercent: null,
    advancedSeoToolsAllowed: false, seoAiSuggestionsAllowed: false, searchConsoleIntegrationAllowed: false,
    customRedirectsAllowed: false, maxActiveStoreBanners: 2, maxActivePromotions: 1,
  },
};

describe('EntitlementsService — trial vs. paid limits', () => {
  let service: EntitlementsService;
  let subModel: any;
  let planModel: any;
  let productModel: any;

  const leanFindOne = (value: any) => jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) });

  function setup(subscription: any | null) {
    subModel = { findOne: leanFindOne(subscription) };
    planModel = {
      findById: leanFindOne(PAID_PLAN),
      findOne: leanFindOne(null),
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };
    productModel = { countDocuments: jest.fn().mockResolvedValue(0) };

    const db = {
      repositories: {
        sellerPlatformSubscriptionModel: subModel,
        platformPlanModel: planModel,
        productModel,
        employeeModel: { countDocuments: jest.fn().mockResolvedValue(0) },
        storeLocationModel: { countDocuments: jest.fn().mockResolvedValue(0) },
        storeBannerModel: { countDocuments: jest.fn().mockResolvedValue(0) },
        promotionRequestModel: { countDocuments: jest.fn().mockResolvedValue(0) },
        platformAddonPurchaseModel: { find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) },
        aiCreditsWalletModel: { findOne: leanFindOne(null) },
      },
    } as unknown as DatabaseService;

    service = new EntitlementsService(db);
  }

  it('a trialing store gets unlimited caps and every boolean feature — but the SAME transactionFeeRate/aiCreditsPerMonth as its assigned plan', async () => {
    setup({ storeId: STORE_ID, status: 'trialing', platformPlanId: 'plan-1' });

    const limits = await service.getLimits(STORE_ID);

    expect(limits.maxProducts).toBe(-1);
    expect(limits.maxStaffAccounts).toBe(-1);
    expect(limits.maxPosLocations).toBe(-1);
    expect(limits.maxActiveStoreBanners).toBe(-1);
    expect(limits.maxActivePromotions).toBe(-1);
    expect(limits.customDomainAllowed).toBe(true);
    expect(limits.whiteLabelAllowed).toBe(true);
    expect(limits.loyaltyProgramAllowed).toBe(true);
    expect(limits.subscriptionProductsAllowed).toBe(true);
    expect(limits.advancedAnalyticsAllowed).toBe(true);
    expect(limits.abandonedCartRecoveryAllowed).toBe(true);
    expect(limits.emailCampaignsAllowed).toBe(true);
    expect(limits.apiWebhooksAllowed).toBe(true);
    expect(limits.advancedSeoToolsAllowed).toBe(true);
    expect(limits.seoAiSuggestionsAllowed).toBe(true);
    expect(limits.searchConsoleIntegrationAllowed).toBe(true);
    expect(limits.customRedirectsAllowed).toBe(true);
    expect(limits.dedicatedAccountManager).toBe(true);
    expect(limits.prioritySupport).toBe(true);
    expect(limits.marketplaceFeaturedBadge).toBe(true);

    // Deliberately untouched — real revenue/cost mechanics, not a restriction to lift.
    expect(limits.transactionFeeRate).toBe(0.03);
    expect(limits.aiCreditsPerMonth).toBe(500);
  });

  it('an active (paid, non-trialing) store keeps exactly its plan\'s real limits — unaffected by the trial bypass', async () => {
    setup({ storeId: STORE_ID, status: 'active', platformPlanId: 'plan-1' });

    const limits = await service.getLimits(STORE_ID);

    expect(limits).toEqual(PAID_PLAN.limits);
  });

  it('a store with no subscription row at all (legacy/pre-migration) falls back to FALLBACK_LIMITS, not the trial bypass', async () => {
    setup(null);
    planModel.findOne = leanFindOne(null); // no free plan configured either

    const limits = await service.getLimits(STORE_ID);

    expect(limits.maxProducts).toBe(10); // FALLBACK_LIMITS value, not -1
    expect(limits.customDomainAllowed).toBe(false);
  });

  it('assertCanCreateProduct does NOT throw for a trialing store even when the real product count already exceeds the assigned plan\'s cap', async () => {
    setup({ storeId: STORE_ID, status: 'trialing', platformPlanId: 'plan-1' });
    productModel.countDocuments.mockResolvedValue(999); // way over the plan's maxProducts: 10

    await expect(service.assertCanCreateProduct(STORE_ID)).resolves.toBeUndefined();
  });

  it('assertCanCreateProduct STILL throws for an active (paid) store at its real limit — proves the bypass does not leak into non-trial subscriptions', async () => {
    setup({ storeId: STORE_ID, status: 'active', platformPlanId: 'plan-1' });
    productModel.countDocuments.mockResolvedValue(10); // exactly at the plan's maxProducts: 10

    await expect(service.assertCanCreateProduct(STORE_ID)).rejects.toThrow(BadRequestException);
  });

  it('getEntitlementsSummary also reflects the trial bypass (the Billing Center UI data path), not just getLimits', async () => {
    setup({ storeId: STORE_ID, status: 'trialing', platformPlanId: 'plan-1' });

    const summary = await service.getEntitlementsSummary(STORE_ID);

    expect(summary.maxProducts.limit).toBe(-1);
    expect(summary.maxProducts.allowed).toBe(true);
    expect(summary.transactionFeeRate).toBe(0.03);
  });
});
