/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';

export interface PlatformPlanLimits {
  maxProducts: number;
  maxStaffAccounts: number;
  maxPosLocations: number;
  aiCreditsPerMonth: number;
  transactionFeeRate: number;
  customDomainAllowed: boolean;
  whiteLabelAllowed: boolean;
  loyaltyProgramAllowed: boolean;
  advancedAnalyticsAllowed: boolean;
  abandonedCartRecoveryAllowed: boolean;
  emailCampaignsAllowed: boolean;
  digitalMembershipsAllowed: boolean;
  digitalLicensesAllowed: boolean;
  b2bWholesaleAllowed: boolean;
  apiWebhooksAllowed: boolean;
  dedicatedAccountManager: boolean;
  prioritySupport: boolean;
  marketplaceFeaturedBadge: boolean;
  slaUptimePercent: number | null;
  advancedSeoToolsAllowed: boolean;
  seoAiSuggestionsAllowed: boolean;
  searchConsoleIntegrationAllowed: boolean;
  customRedirectsAllowed: boolean;
  maxActiveStoreBanners: number;
  maxActivePromotions: number;
  /** Shopify "third-party calculated shipping rates" — live carrier rates
   *  at checkout (Solvexo: the Shippo integration). Shopify: Advanced+ only. */
  calculatedShippingRatesAllowed: boolean;
  /** Shopify "markets" — how many checkout currencies a store may enable
   *  (Store.enabledCurrencies, base currency always included). -1 = unlimited. */
  maxMarkets: number;
  /** Gates creating courses (Digital hub). */
  digitalCoursesAllowed: boolean;
  /** Wholesale catalogs per store (Shopify caps non-Plus plans at 3). -1 = unlimited. */
  maxB2BCatalogs: number;
  /** Marketing-campaign emails per calendar month. Automations and abandoned-cart mails are not counted (Shopify does not count abandoned checkout mails either). */
  monthlyEmailSends: number;
}

/** Values used for any field an OLDER plan document doesn't have yet (a plan
 *  saved before that field existed). Merged under the plan's own limits so
 *  a missing field never reads as `undefined`. Deliberately generous: an old
 *  plan document must not suddenly lose something it never had a limit on. */
const NEW_FIELD_DEFAULTS: Pick<PlatformPlanLimits, 'calculatedShippingRatesAllowed' | 'maxMarkets' | 'digitalCoursesAllowed' | 'maxB2BCatalogs' | 'monthlyEmailSends'> = {
  calculatedShippingRatesAllowed: false,
  maxMarkets: 3,
  digitalCoursesAllowed: true,
  maxB2BCatalogs: -1,
  monthlyEmailSends: 10000,
};

/** AI credits a store gets while it is still on its free trial (no plan yet): enough to try the tools, small enough to cost little. */
export const TRIAL_AI_CREDITS = 50;

/** First day of the calendar month (UTC) a monthly allowance counts from. */
export function startOfMonthUTC(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Keeps a store's checkout currencies within its plan's market limit —
 *  base currency always kept first, extras dropped in their saved order. */
export function trimToMarketsLimit(allowed: string[], baseCurrency: string | null | undefined, maxMarkets: number): string[] {
  if (maxMarkets === -1 || allowed.length <= maxMarkets) return allowed;
  const ordered = baseCurrency && allowed.includes(baseCurrency)
    ? [baseCurrency, ...allowed.filter((c) => c !== baseCurrency)]
    : allowed;
  return ordered.slice(0, Math.max(1, maxMarkets));
}

// Used only as a last-resort fallback for a store that somehow has no
// SellerPlatformSubscription row at all AND no free plan exists yet in the
// DB (e.g. right after this feature is deployed, before an admin has
// created any PlatformPlan). Deliberately generous-but-not-unlimited so
// nothing breaks for existing stores during the rollout window.
const FALLBACK_LIMITS: PlatformPlanLimits = {
  maxProducts: 10, maxStaffAccounts: 0, maxPosLocations: 1, aiCreditsPerMonth: 0,
  // 0, not a made-up rate: Shopify only charges a third-party transaction fee
  // that the merchant's PLAN defines. A store with no resolvable plan used to be
  // billed a hardcoded 8% here, which exists nowhere in Shopify.
  transactionFeeRate: 0, customDomainAllowed: false, whiteLabelAllowed: false,
  loyaltyProgramAllowed: false, advancedAnalyticsAllowed: false,
  abandonedCartRecoveryAllowed: false, emailCampaignsAllowed: false, apiWebhooksAllowed: false,
  // digital delivery is free for every plan; these two default ON and an admin can switch them off per plan
  digitalMembershipsAllowed: true, digitalLicensesAllowed: true, b2bWholesaleAllowed: true,
  dedicatedAccountManager: false, prioritySupport: false, marketplaceFeaturedBadge: false, slaUptimePercent: null,
  advancedSeoToolsAllowed: false, seoAiSuggestionsAllowed: false, searchConsoleIntegrationAllowed: false, customRedirectsAllowed: false,
  maxActiveStoreBanners: -1, maxActivePromotions: -1,
  calculatedShippingRatesAllowed: false, maxMarkets: 1,
  // A store with no resolvable plan (e.g. a standalone trial) can try wholesale and courses, but sends only a few campaign emails.
  digitalCoursesAllowed: true, maxB2BCatalogs: 3, monthlyEmailSends: 500,
};

const BOOLEAN_FEATURES: Array<{ key: keyof PlatformPlanLimits; label: string }> = [
  { key: 'customDomainAllowed', label: 'Custom domain' },
  { key: 'whiteLabelAllowed', label: 'White-label branding' },
  { key: 'loyaltyProgramAllowed', label: 'Loyalty & rewards program' },
  { key: 'advancedAnalyticsAllowed', label: 'Advanced analytics' },
  { key: 'abandonedCartRecoveryAllowed', label: 'Abandoned cart recovery' },
  { key: 'emailCampaignsAllowed', label: 'Email campaigns' },
  { key: 'digitalMembershipsAllowed', label: 'Memberships & access plans' },
  { key: 'digitalLicensesAllowed', label: 'License keys' }, { key: 'digitalCoursesAllowed', label: 'Courses' },
  { key: 'b2bWholesaleAllowed', label: 'Wholesale (B2B)' },
  { key: 'apiWebhooksAllowed', label: 'API access & webhooks' },
  { key: 'advancedSeoToolsAllowed', label: 'Advanced SEO tools (audit, score, checklist)' },
  { key: 'seoAiSuggestionsAllowed', label: 'AI-generated SEO suggestions' },
  { key: 'searchConsoleIntegrationAllowed', label: 'Search Console / Bing Webmaster integration' },
  { key: 'customRedirectsAllowed', label: 'Custom redirects & canonical overrides' },
  { key: 'calculatedShippingRatesAllowed', label: 'Live carrier shipping rates' },
];

/**
 * Central "what can this store do" resolver for the PlatformPlan system —
 * the same architectural role `SubscriptionBenefitsService` plays for the
 * buyer-facing VIP-plan system. Every module that needs to gate a feature
 * behind a platform tier (Products, Employee/staff, Store builder, Loyalty,
 * the buyer-subscription module itself, Finance's transaction fee) goes
 * through this one service so the limits are defined and enforced in
 * exactly one place.
 */
@Injectable()
export class EntitlementsService {
  constructor(private readonly db: DatabaseService) {}

  private get planModel() { return this.db.repositories.platformPlanModel; }
  private get subModel() { return this.db.repositories.sellerPlatformSubscriptionModel; }

  /**
   * A trialing store's `platformPlanId` is `null` by design (trial is a
   * standalone concept — see `PlatformTrialSettings`) — `plan: null` is a
   * valid, expected result here, NOT "no subscription found." Returning
   * `null` in that case (as this used to) silently dropped the real
   * `subscription` object from the caller, which made `applyTrialOverride`
   * below think the store wasn't trialing at all (it reads
   * `subscription?.status`) — a real bug, fixed by always returning the
   * subscription once one exists, regardless of whether a plan is attached.
   */
  async getActivePlanForStore(storeId: string): Promise<{ subscription: any; plan: any } | null> {
    const subscription = await this.subModel.findOne({ storeId, isDelete: false }).lean();
    if (!subscription) return null;
    const plan = (subscription as any).platformPlanId
      ? await this.planModel.findById((subscription as any).platformPlanId).lean()
      : null;
    return { subscription, plan };
  }

  private async resolvePlan(storeId: string): Promise<{ plan: any; subscription: any | null }> {
    const result = await this.getActivePlanForStore(storeId);
    if (result) return result;
    // No subscription row yet AT ALL (store predates this feature, or
    // auto-assign hasn't run) — fall back to whichever plan is marked free,
    // if any. Distinct from the trialing-with-no-plan case above, which
    // already returned above with a real (non-null) `subscription`.
    const plan = await this.planModel.findOne({ isFree: true, status: 'active', isDelete: false }).lean();
    return { plan, subscription: null };
  }

  /**
   * A `trialing` store gets full/open access to every product/staff/
   * location/banner/promotion cap and most boolean features — same
   * philosophy as Shopify's own trial (no plan needs to be chosen to use
   * the store-building features, only to keep selling once the trial
   * ends). Deliberately does NOT touch `transactionFeeRate` or `monthlyEmailSends`:
   * those aren't restrictions being tested, they're real revenue/cost
   * mechanics that must stay exactly what the assigned plan defines whether
   * trialing or not — a trial sale still owes Solvexo its real commission.
   * `aiCreditsPerMonth` gets a small fixed trial allowance (TRIAL_AI_CREDITS)
   * when the plan gives less: a trialing store has no plan row, so it would
   * otherwise get a wallet with 0 credits and AI Studio would be unusable all
   * trial long. It is never `-1` because `AiCreditsService.deduct` treats a
   * negative balance as "insufficient", not "unlimited".
   *
   * `customDomainAllowed` is the one deliberate EXCEPTION, always forced
   * `false` here regardless of the underlying plan — verified against
   * Shopify's own real trial (a standard trial cannot connect a custom
   * domain; that only unlocks once a plan is chosen), matching real-world
   * platform convention rather than this project's own earlier, more
   * permissive default. Real checkout/order-placement is blocked
   * separately, in `BillingAccessGuard` (`blockDuringTrial`), not here —
   * this service only governs feature/limit gates, not the billing-status
   * guard's own route-blocking.
   */
  private applyTrialOverride(limits: PlatformPlanLimits, subscription: any | null): PlatformPlanLimits {
    if (subscription?.status !== 'trialing') return limits;
    return {
      ...limits,
      maxProducts: -1,
      maxStaffAccounts: -1,
      maxPosLocations: -1,
      maxActiveStoreBanners: -1,
      maxActivePromotions: -1,
      customDomainAllowed: false,
      whiteLabelAllowed: true,
      loyaltyProgramAllowed: true,
      advancedAnalyticsAllowed: true,
      abandonedCartRecoveryAllowed: true,
      emailCampaignsAllowed: true,
      digitalMembershipsAllowed: true,
      digitalLicensesAllowed: true, b2bWholesaleAllowed: true,
      apiWebhooksAllowed: true,
      advancedSeoToolsAllowed: true,
      seoAiSuggestionsAllowed: true,
      searchConsoleIntegrationAllowed: true,
      customRedirectsAllowed: true,
      dedicatedAccountManager: true,
      prioritySupport: true,
      marketplaceFeaturedBadge: true,
      calculatedShippingRatesAllowed: true,
      maxMarkets: -1,
      digitalCoursesAllowed: true,
      maxB2BCatalogs: -1,
      aiCreditsPerMonth: Math.max(limits.aiCreditsPerMonth, TRIAL_AI_CREDITS),
    };
  }

  async getLimits(storeId: string): Promise<PlatformPlanLimits> {
    const { plan, subscription } = await this.resolvePlan(storeId);
    const base: PlatformPlanLimits = plan?.limits ? { ...NEW_FIELD_DEFAULTS, ...(plan.limits as PlatformPlanLimits) } : FALLBACK_LIMITS;
    return this.applyTrialOverride(base, subscription);
  }

  async getTransactionFeeRate(storeId: string): Promise<number> {
    const limits = await this.getLimits(storeId);
    return limits.transactionFeeRate ?? FALLBACK_LIMITS.transactionFeeRate;
  }

  /** Throws if the store is already at (or over) its product limit. Call BEFORE creating a new product. */
  /** True when the store holds MORE live products than its plan allows (used right after a create to settle a race). */
  async isOverProductLimit(storeId: string): Promise<boolean> {
    const limits = await this.getLimits(storeId);
    if (limits.maxProducts === -1) return false;
    const count = await this.db.repositories.productModel.countDocuments({ storeId, isDelete: false });
    return count > limits.maxProducts;
  }

  async assertCanCreateProduct(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxProducts === -1) return;
    const count = await this.db.repositories.productModel.countDocuments({ storeId, isDelete: false });
    if (count >= limits.maxProducts) {
      throw new BadRequestException(
        `Product limit reached (${limits.maxProducts}) for your current plan — upgrade your platform plan to add more products.`,
      );
    }
  }

  /**
   * Counts the store's dashboard staff accounts exactly the way Shopify
   * counts "users" against a plan: every non-removed, active staff member
   * (pending invites included — an invite holds a seat). POS-only employees
   * (PIN login, no dashboard access) are deliberately NOT counted — Shopify's
   * own rule: "POS only staff ... do not count toward the user limit".
   * Any still-active legacy "extra staff seat" add-on keeps its paid seats
   * until that add-on lapses (the add-on itself is no longer sold).
   */
  async countStaffSeats(storeId: string): Promise<{ used: number; extraSeats: number }> {
    const [used, extraSeatAddons] = await Promise.all([
      this.db.repositories.staffMemberModel.countDocuments({ storeId, isDelete: false, status: 'active' }),
      this.db.repositories.platformAddonPurchaseModel
        .find({ storeId, addonType: 'extra_staff_seat', status: 'active' }).lean(),
    ]);
    const extraSeats = (extraSeatAddons as any[]).reduce((sum: number, a: any) => sum + (a.quantity ?? 1), 0);
    return { used, extraSeats };
  }

  /** Throws if the store is already at (or over) its staff-account limit. Call BEFORE inviting or re-activating a dashboard staff member. */
  async assertCanAddStaff(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxStaffAccounts === -1) return;

    const { used, extraSeats } = await this.countStaffSeats(storeId);
    const effectiveLimit = limits.maxStaffAccounts + extraSeats;
    if (used >= effectiveLimit) {
      throw new BadRequestException(
        effectiveLimit === 0
          ? 'Staff accounts are not included in your current plan — upgrade your plan to add staff.'
          : `Staff account limit reached (${effectiveLimit}) for your current plan — upgrade your plan or deactivate a staff member to add another.`,
      );
    }
  }

  /** Throws if the store is already at (or over) its POS-location limit. Call BEFORE creating a new StoreLocation. */
  async assertCanAddLocation(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxPosLocations === -1) return;
    const count = await this.db.repositories.storeLocationModel.countDocuments({ storeId, status: 'active', isDelete: false });
    if (count >= limits.maxPosLocations) {
      throw new BadRequestException(
        limits.maxPosLocations <= 1
          ? 'Multi-location POS is not available on your current plan — upgrade your platform plan to add another branch.'
          : `POS location limit reached (${limits.maxPosLocations}) for your current plan — upgrade your platform plan to add more branches.`,
      );
    }
  }

  /** Throws if the store already has its plan's limit of StoreBanner rows. Call BEFORE creating a new one.
   *  Deliberately counts ALL rows (not just `status:'active'`) — this is a plan-tier creation cap, distinct
   *  from `PlatformConfig.placementLimits.storeHero` which only bounds how many rotate on the storefront at once. */
  async assertCanCreateStoreBanner(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxActiveStoreBanners === -1) return;
    const count = await this.db.repositories.storeBannerModel.countDocuments({ storeId });
    if (count >= limits.maxActiveStoreBanners) {
      throw new BadRequestException(
        `Store banner limit reached (${limits.maxActiveStoreBanners}) for your current plan — upgrade your platform plan or delete an existing banner to add more.`,
      );
    }
  }

  /** Throws if the store already has its plan's limit of concurrently pending/approved/active PromotionRequests. */
  async assertCanCreatePromotion(storeId: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (limits.maxActivePromotions === -1) return;
    const count = await this.db.repositories.promotionRequestModel.countDocuments({
      storeId, status: { $in: ['pending', 'approved', 'active'] },
    });
    if (count >= limits.maxActivePromotions) {
      throw new BadRequestException(
        `You already have ${limits.maxActivePromotions} promotion request(s) in progress — your current plan allows ${limits.maxActivePromotions} at a time. Upgrade your platform plan or wait for one to finish.`,
      );
    }
  }

  /**
   * Marketing emails this store has used this calendar month (UTC): campaign emails (queued), automation emails (welcome, back in
   * stock, price drop, win-back: delivered ones) and abandoned-cart reminders. Order and account mails are not marketing and not counted.
   */
  async getMonthlyEmailUsage(storeId: string, now = new Date()): Promise<number> {
    const from = startOfMonthUTC(now);
    const r = this.db.repositories as any;
    const [campaign, automation, abandoned, abandonedSecond] = await Promise.all([
      r.emailCampaignSendModel.countDocuments({ storeId, createdAt: { $gte: from } }),
      r.automationSendLogModel ? r.automationSendLogModel.countDocuments({ storeId, delivered: true, createdAt: { $gte: from } }) : 0,
      r.checkoutModel ? r.checkoutModel.countDocuments({ abandonedEmailStoreId: storeId, abandonedEmailSentAt: { $gte: from } }) : 0,
      r.checkoutModel ? r.checkoutModel.countDocuments({ abandonedEmailStoreId: storeId, abandonedSecondEmailSentAt: { $gte: from } }) : 0,
    ]);
    return campaign + automation + abandoned + abandonedSecond;
  }

  /** How many more marketing emails this store may send this month (0 when the plan has no marketing emails or the allowance is used up). */
  async getEmailRoom(storeId: string, feature: 'emailCampaignsAllowed' | 'abandonedCartRecoveryAllowed' = 'emailCampaignsAllowed', now = new Date()): Promise<number> {
    const limits = await this.getLimits(storeId);
    if (!limits[feature]) return 0;
    const used = await this.getMonthlyEmailUsage(storeId, now);
    return Math.max(0, limits.monthlyEmailSends - used);
  }

  /** Throws if sending `recipients` more campaign emails would pass the plan's monthly allowance. Call BEFORE creating the send rows. */
  async assertEmailAllowance(storeId: string, recipients: number, now = new Date()): Promise<void> {
    const { monthlyEmailSends } = await this.getLimits(storeId);
    const used = await this.getMonthlyEmailUsage(storeId, now);
    if (used + recipients > monthlyEmailSends) {
      const left = Math.max(0, monthlyEmailSends - used);
      throw new BadRequestException(
        `This campaign needs ${recipients.toLocaleString('en-US')} emails but your plan has ${left.toLocaleString('en-US')} left this month (${monthlyEmailSends.toLocaleString('en-US')} a month) — send to a smaller audience, wait for next month or upgrade your plan.`,
      );
    }
  }

  /** Throws if the store already has its plan's number of wholesale catalogs. `current` = how many it has now. */
  async assertCanCreateB2BCatalog(storeId: string, current: number): Promise<void> {
    const { maxB2BCatalogs } = await this.getLimits(storeId);
    if (maxB2BCatalogs !== -1 && current >= maxB2BCatalogs) {
      throw new BadRequestException(
        `Your plan allows ${maxB2BCatalogs} wholesale catalog${maxB2BCatalogs === 1 ? '' : 's'} — upgrade your plan or delete one to add another.`,
      );
    }
  }

  /** Generic boolean-feature gate — throws ForbiddenException with an upgrade hint if the store's plan doesn't include it. */
  async assertFeatureAllowed(storeId: string, feature: keyof PlatformPlanLimits, featureLabel: string): Promise<void> {
    const limits = await this.getLimits(storeId);
    if (!limits[feature]) {
      const requiredPlan = await this.cheapestPlanWithFeature(feature);
      throw new ForbiddenException(
        `${featureLabel} is not included in your current platform plan${requiredPlan ? ` — available starting with the "${requiredPlan}" plan` : ''}.`,
      );
    }
  }

  private async cheapestPlanWithFeature(feature: keyof PlatformPlanLimits): Promise<string | null> {
    const plans = await this.planModel.find({ status: 'active', isDelete: false }).sort({ sortOrder: 1 }).lean();
    const match = plans.find((p: any) => p.limits?.[feature]);
    return match?.name ?? null;
  }

  /**
   * Full feature matrix for a store — what the frontend renders the pricing
   * table's "included / greyed-out with upgrade hint" UI from. One call, no
   * frontend business logic needed.
   */
  async getEntitlementsSummary(storeId: string) {
    const { plan, subscription } = await this.resolvePlan(storeId);
    const base: PlatformPlanLimits = plan?.limits ? { ...NEW_FIELD_DEFAULTS, ...(plan.limits as PlatformPlanLimits) } : FALLBACK_LIMITS;
    const limits: PlatformPlanLimits = this.applyTrialOverride(base, subscription);

    const [productCount, staffSeats, posLocationCount, aiWallet, allActivePlans] = await Promise.all([
      this.db.repositories.productModel.countDocuments({ storeId, isDelete: false }),
      // Same seat count assertCanAddStaff() enforces — dashboard staff only.
      this.countStaffSeats(storeId),
      // Same count assertCanAddLocation() already uses to gate creation —
      // reused here so the usage meter shows the real number instead of a
      // hardcoded 0.
      this.db.repositories.storeLocationModel.countDocuments({ storeId, status: 'active', isDelete: false }),
      this.db.repositories.aiCreditsWalletModel.findOne({ storeId }).lean(),
      this.planModel.find({ status: 'active', isDelete: false }).sort({ sortOrder: 1 }).lean(),
    ]);

    const cheapestWith = (feature: keyof PlatformPlanLimits) =>
      (allActivePlans as any[]).find((p) => p.limits?.[feature])?.name ?? null;

    const booleanFeatures: Record<string, { allowed: boolean; requiredPlan: string | null }> = {};
    for (const { key, label } of BOOLEAN_FEATURES) {
      booleanFeatures[key] = { allowed: !!limits[key], requiredPlan: limits[key] ? null : cheapestWith(key) };
      void label; // label is for assertFeatureAllowed's error message, not needed in the summary payload
    }

    return {
      // `plan` is legitimately null while trialing (see `getActivePlanForStore`'s
      // doc comment) — "Trial" there, never a borrowed/fake plan name; the
      // genuine no-subscription-row-at-all fallback still reads "Starter (default)".
      currentPlanName: plan?.name ?? (subscription?.status === 'trialing' ? 'Trial' : 'Starter (default)'),
      currentPlanId: plan?._id?.toString?.() ?? null,
      maxProducts: {
        limit: limits.maxProducts, used: productCount,
        allowed: limits.maxProducts === -1 || productCount < limits.maxProducts,
      },
      maxStaffAccounts: {
        limit: limits.maxStaffAccounts === -1 ? -1 : limits.maxStaffAccounts + staffSeats.extraSeats,
        used: staffSeats.used,
        allowed: limits.maxStaffAccounts === -1 || staffSeats.used < limits.maxStaffAccounts + staffSeats.extraSeats,
      },
      maxPosLocations: {
        limit: limits.maxPosLocations, used: posLocationCount,
        allowed: limits.maxPosLocations === -1 || posLocationCount < limits.maxPosLocations,
      },
      aiCredits: {
        monthlyAllowance: limits.aiCreditsPerMonth,
        // A store that has not used AI yet has no wallet row: it will be created with the full allowance, so show that (not 0 = "all used").
        // A wallet that has not seen its plan change yet is shown with the extra allowance it will get on its next use.
        balance: aiWallet
          ? ((aiWallet as any).balance ?? 0) + Math.max(0, limits.aiCreditsPerMonth - ((aiWallet as any).monthlyAllowance ?? 0))
          : limits.aiCreditsPerMonth,
      },
      transactionFeeRate: limits.transactionFeeRate,
      maxMarkets: limits.maxMarkets,
      maxB2BCatalogs: limits.maxB2BCatalogs,
      monthlyEmailSends: limits.monthlyEmailSends,
      ...booleanFeatures,
      dedicatedAccountManager: !!limits.dedicatedAccountManager,
      prioritySupport: !!limits.prioritySupport,
      marketplaceFeaturedBadge: !!limits.marketplaceFeaturedBadge,
      slaUptimePercent: limits.slaUptimePercent ?? null,
    };
  }
}
