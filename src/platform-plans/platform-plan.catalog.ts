/* eslint-disable prettier/prettier */
import type { PlatformPlan } from './schemas/platform-plan.schema';

/**
 * THE source of truth for what each Solvexo platform plan INCLUDES.
 *
 * Solvexo's plans are fixed in code (like Shopify's Basic / Grow / Advanced / Plus):
 * what a plan contains — its limits and feature switches — is defined here, reviewed,
 * tested and deployed. The admin panel only manages how a plan is SOLD (price, intro
 * offer, badge, visibility, text) and edits the limit values inside guard-rails
 * (see `validatePlanLimits` / `validateTierOrder`). Admins can't create, delete or
 * archive these four plans, and can't change what kind of plan one is.
 *
 * Every limit below is one the backend REALLY enforces (EntitlementsService + the
 * feature guards it feeds) — a switch that nothing checks must never be sold.
 * Deliberately `false`/`null` in every plan, because the product has nothing behind
 * them yet: `advancedAnalyticsAllowed`, `apiWebhooksAllowed`, `marketplaceFeaturedBadge`,
 * `slaUptimePercent`. Turn one on only once the feature behind it exists.
 *
 * `transactionFeeRate` is the Shopify-style THIRD-PARTY gateway fee: charged only on sales paid through
 * a gateway other than Solvexo Payments (SafePay, JazzCash…). Card sales through Solvexo Payments and
 * manual payments (COD, bank transfer) carry no commission — see commission-rules/payment-rail.ts.
 *
 * Everything else Solvexo ships (orders, draft orders, returns, gift cards, discount
 * codes, blog/pages/menus, themes & editor, inventory/purchase orders/stock counts,
 * Shippo shipping, newsletters, reviews, messaging, affiliate, tracking pixels,
 * metafields, integrations, mobile-app request…) has no plan gate, so it is part of
 * EVERY plan and is shown as such rather than as a per-plan row.
 */
export type PlanLimits = PlatformPlan['limits'];
export type PlanKey = 'basic' | 'grow' | 'advanced' | 'enterprise';

/** Bump when the limits/features in `PLAN_CATALOG` change — existing plan documents
 *  are re-aligned to the catalog once per bump (see PlatformPlanCatalogService). */
export const CATALOG_VERSION = 3; // v2: Enterprise became fixed-price · v3: transactionFeeRate now means the Shopify-style third-party gateway fee

export interface CatalogPlan {
  key: PlanKey;
  name: string;
  description: string;
  sortOrder: number;
  badge: string | null;
  /** "Contact Sales" — no self-serve checkout, assigned to a store by an admin. (None of the four core plans uses it today.) */
  isCustomPricing: boolean;
  monthlyPriceUSD: number | null;
  yearlyPriceUSD: number | null;
  /** Shopify-style "$1/mo for 3 months" — monthly billing only. */
  intro: { priceUSD: number; durationCycles: number } | null;
  gracePeriodDays: number;
  limits: PlanLimits;
}

/** Switches/limits that are OFF/empty on every plan until the feature behind them exists. */
const NOT_OFFERED = {
  advancedAnalyticsAllowed: false,
  apiWebhooksAllowed: false,
  marketplaceFeaturedBadge: false,
  slaUptimePercent: null,
} as const;

export const PLAN_CATALOG: CatalogPlan[] = [
  {
    key: 'basic', name: 'Basic', sortOrder: 1, badge: null, isCustomPricing: false,
    description: 'Everything you need to launch your store and make your first sales.',
    monthlyPriceUSD: 10, yearlyPriceUSD: 96,
    intro: { priceUSD: 1, durationCycles: 3 },
    gracePeriodDays: 3,
    limits: {
      maxProducts: 25, maxStaffAccounts: 1, maxPosLocations: 1, aiCreditsPerMonth: 100,
      transactionFeeRate: 0.02,
      maxActiveStoreBanners: 4, maxActivePromotions: 1, maxMarkets: 3,
      customDomainAllowed: true, emailCampaignsAllowed: true, advancedSeoToolsAllowed: true,
      abandonedCartRecoveryAllowed: false, loyaltyProgramAllowed: false, customRedirectsAllowed: false,
      seoAiSuggestionsAllowed: false, prioritySupport: false,
      whiteLabelAllowed: false, searchConsoleIntegrationAllowed: false,
      calculatedShippingRatesAllowed: false, dedicatedAccountManager: false,
      ...NOT_OFFERED,
    },
  },
  {
    key: 'grow', name: 'Grow', sortOrder: 2, badge: 'Most Popular', isCustomPricing: false,
    description: 'For growing sellers who want more reach, more staff and marketing tools.',
    monthlyPriceUSD: 49, yearlyPriceUSD: 470,
    intro: { priceUSD: 1, durationCycles: 3 },
    gracePeriodDays: 3,
    limits: {
      maxProducts: -1, maxStaffAccounts: 5, maxPosLocations: 3, aiCreditsPerMonth: 500,
      transactionFeeRate: 0.01,
      maxActiveStoreBanners: 10, maxActivePromotions: 5, maxMarkets: 5,
      customDomainAllowed: true, emailCampaignsAllowed: true, advancedSeoToolsAllowed: true,
      abandonedCartRecoveryAllowed: true, loyaltyProgramAllowed: true, customRedirectsAllowed: true,
      seoAiSuggestionsAllowed: true, prioritySupport: true,
      whiteLabelAllowed: false, searchConsoleIntegrationAllowed: false,
      calculatedShippingRatesAllowed: false, dedicatedAccountManager: false,
      ...NOT_OFFERED,
    },
  },
  {
    key: 'advanced', name: 'Advanced', sortOrder: 3, badge: null, isCustomPricing: false,
    description: 'For scaling businesses that need advanced selling and brand controls.',
    monthlyPriceUSD: 99, yearlyPriceUSD: 950,
    intro: { priceUSD: 1, durationCycles: 3 },
    gracePeriodDays: 3,
    limits: {
      maxProducts: -1, maxStaffAccounts: 15, maxPosLocations: 10, aiCreditsPerMonth: 2000,
      transactionFeeRate: 0.006,
      maxActiveStoreBanners: -1, maxActivePromotions: -1, maxMarkets: 10,
      customDomainAllowed: true, emailCampaignsAllowed: true, advancedSeoToolsAllowed: true,
      abandonedCartRecoveryAllowed: true, loyaltyProgramAllowed: true, customRedirectsAllowed: true,
      seoAiSuggestionsAllowed: true, prioritySupport: true,
      whiteLabelAllowed: true, searchConsoleIntegrationAllowed: true,
      calculatedShippingRatesAllowed: true, dedicatedAccountManager: false,
      ...NOT_OFFERED,
    },
  },
  {
    key: 'enterprise', name: 'Enterprise', sortOrder: 4, badge: null, isCustomPricing: false,
    description: 'For large and complex businesses — unlimited everything with a dedicated account manager.',
    monthlyPriceUSD: 299, yearlyPriceUSD: 2870, intro: null,
    gracePeriodDays: 7,
    limits: {
      maxProducts: -1, maxStaffAccounts: -1, maxPosLocations: -1, aiCreditsPerMonth: 10000,
      transactionFeeRate: 0.002,
      maxActiveStoreBanners: -1, maxActivePromotions: -1, maxMarkets: -1,
      customDomainAllowed: true, emailCampaignsAllowed: true, advancedSeoToolsAllowed: true,
      abandonedCartRecoveryAllowed: true, loyaltyProgramAllowed: true, customRedirectsAllowed: true,
      seoAiSuggestionsAllowed: true, prioritySupport: true,
      whiteLabelAllowed: true, searchConsoleIntegrationAllowed: true,
      calculatedShippingRatesAllowed: true, dedicatedAccountManager: true,
      ...NOT_OFFERED,
    },
  },
];

// ── Limit definitions shared by validation, tier ordering and bullet text ─────

type NumericKey =
  | 'maxProducts' | 'maxStaffAccounts' | 'maxPosLocations' | 'aiCreditsPerMonth'
  | 'maxActiveStoreBanners' | 'maxActivePromotions' | 'maxMarkets';
type FlagKey =
  | 'customDomainAllowed' | 'emailCampaignsAllowed' | 'advancedSeoToolsAllowed'
  | 'abandonedCartRecoveryAllowed' | 'loyaltyProgramAllowed' | 'customRedirectsAllowed'
  | 'seoAiSuggestionsAllowed' | 'prioritySupport' | 'whiteLabelAllowed'
  | 'searchConsoleIntegrationAllowed'
  | 'calculatedShippingRatesAllowed' | 'dedicatedAccountManager';

/** `min` = lowest legal non-unlimited value; `unlimited` = whether -1 means unlimited
 *  (AI credits aren't -1-aware in AiCreditsService, so they must stay a real number). */
const NUMERIC_LIMITS: Record<NumericKey, { label: string; min: number; unlimited: boolean }> = {
  maxProducts:           { label: 'Products', min: 1, unlimited: true },
  maxStaffAccounts:      { label: 'Staff accounts', min: 0, unlimited: true },
  maxPosLocations:       { label: 'POS / inventory locations', min: 1, unlimited: true },
  aiCreditsPerMonth:     { label: 'AI credits per month', min: 0, unlimited: false },
  maxActiveStoreBanners: { label: 'Store banners', min: 1, unlimited: true },
  maxActivePromotions:   { label: 'Active promotions', min: 1, unlimited: true },
  maxMarkets:            { label: 'Selling currencies (markets)', min: 1, unlimited: true },
};

/** Feature switches that are real (enforced, or an explicit human promise), in display order. */
export const FLAG_FEATURES: { key: FlagKey; label: string }[] = [
  { key: 'customDomainAllowed', label: 'Custom domain' },
  { key: 'emailCampaignsAllowed', label: 'Email campaigns & marketing automations' },
  { key: 'advancedSeoToolsAllowed', label: 'SEO audit & score tools' },
  { key: 'abandonedCartRecoveryAllowed', label: 'Abandoned cart recovery' },
  { key: 'loyaltyProgramAllowed', label: 'Loyalty & rewards program' },
  { key: 'customRedirectsAllowed', label: 'Custom redirects & canonical rules' },
  { key: 'seoAiSuggestionsAllowed', label: 'AI SEO suggestions' },
  { key: 'whiteLabelAllowed', label: 'White-label branding' },
  { key: 'searchConsoleIntegrationAllowed', label: 'Google Search Console integration' },
  { key: 'calculatedShippingRatesAllowed', label: 'Live carrier shipping rates at checkout' },
  { key: 'prioritySupport', label: 'Priority support' },
  { key: 'dedicatedAccountManager', label: 'Dedicated account manager' },
];

const rank = (n: number) => (n === -1 ? Number.POSITIVE_INFINITY : n);

// ── Validation ───────────────────────────────────────────────────────────────

/** Rules one plan's limits must satisfy on their own. Returns human-readable problems ([] = valid). */
export function validatePlanLimits(limits: Partial<PlanLimits> | undefined | null): string[] {
  const problems: string[] = [];
  if (!limits) return ['Limits are missing.'];
  for (const [key, def] of Object.entries(NUMERIC_LIMITS) as [NumericKey, (typeof NUMERIC_LIMITS)[NumericKey]][]) {
    const v = limits[key];
    if (typeof v !== 'number' || Number.isNaN(v)) { problems.push(`${def.label} is required.`); continue; }
    if (def.unlimited && v === -1) continue;
    if (v < def.min) {
      problems.push(`${def.label} must be ${def.unlimited ? `-1 (unlimited) or at least ${def.min}` : `at least ${def.min}`}.`);
    }
  }
  const fee = limits.transactionFeeRate;
  if (typeof fee !== 'number' || fee < 0 || fee > 0.3) problems.push('Transaction fee must be between 0% and 30%.');
  for (const { key, label } of FLAG_FEATURES) {
    if (typeof limits[key] !== 'boolean') problems.push(`${label} must be on or off.`);
  }
  return problems;
}

/** Each higher plan must include at least what the plan below it includes (and charge no higher fee). */
export function validateTierOrder(lower: { name: string; limits: PlanLimits }, higher: { name: string; limits: PlanLimits }): string[] {
  const problems: string[] = [];
  for (const [key, def] of Object.entries(NUMERIC_LIMITS) as [NumericKey, (typeof NUMERIC_LIMITS)[NumericKey]][]) {
    if (rank(higher.limits[key]) < rank(lower.limits[key])) {
      problems.push(`${higher.name} can't offer fewer "${def.label}" than ${lower.name}.`);
    }
  }
  if (higher.limits.transactionFeeRate > lower.limits.transactionFeeRate) {
    problems.push(`${higher.name} can't charge a higher transaction fee than ${lower.name}.`);
  }
  for (const { key, label } of FLAG_FEATURES) {
    if (lower.limits[key] && !higher.limits[key]) {
      problems.push(`${higher.name} must include "${label}" because ${lower.name} does.`);
    }
  }
  return problems;
}

/** Commercial rules for a plan's prices. Returns problems ([] = valid). */
export function validatePlanPricing(p: {
  isFree?: boolean; isCustomPricing?: boolean;
  monthlyPriceUSD: number | null; yearlyPriceUSD: number | null;
  introOfferEnabled?: boolean; introPriceUSD?: number | null; introDurationCycles?: number | null;
}): string[] {
  const problems: string[] = [];
  const selfServe = !p.isFree && !p.isCustomPricing;
  if (selfServe && !(typeof p.monthlyPriceUSD === 'number' && p.monthlyPriceUSD > 0)) {
    problems.push('Monthly price must be greater than 0.');
  }
  if (selfServe && typeof p.monthlyPriceUSD === 'number' && typeof p.yearlyPriceUSD === 'number') {
    const full = p.monthlyPriceUSD * 12;
    if (p.yearlyPriceUSD > full) problems.push(`Yearly price ($${p.yearlyPriceUSD}) can't be more than 12 months at the monthly price ($${full}).`);
    if (p.yearlyPriceUSD < full * 0.5) problems.push(`Yearly price ($${p.yearlyPriceUSD}) can't be more than 50% below 12 months at the monthly price ($${full}).`);
  }
  if (p.introOfferEnabled) {
    if (p.introPriceUSD == null || p.introDurationCycles == null) problems.push('The intro offer needs both a price and a number of months.');
    else if (typeof p.monthlyPriceUSD === 'number' && p.introPriceUSD >= p.monthlyPriceUSD) problems.push('The intro price must be lower than the regular monthly price.');
    else if (p.introDurationCycles < 1) problems.push('The intro offer must last at least 1 month.');
  }
  return problems;
}

/** Throws if the shipped catalog itself is inconsistent — called at boot so a bad
 *  catalog edit fails the deploy instead of reaching sellers. */
export function assertCatalogValid(catalog: CatalogPlan[] = PLAN_CATALOG): void {
  const problems: string[] = [];
  const keys = new Set<string>();
  const sorted = [...catalog].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const plan of sorted) {
    if (keys.has(plan.key)) problems.push(`Duplicate plan key "${plan.key}".`);
    keys.add(plan.key);
    problems.push(...validatePlanLimits(plan.limits).map(m => `${plan.name}: ${m}`));
    problems.push(...validatePlanPricing({
      isCustomPricing: plan.isCustomPricing, monthlyPriceUSD: plan.monthlyPriceUSD, yearlyPriceUSD: plan.yearlyPriceUSD,
      introOfferEnabled: !!plan.intro, introPriceUSD: plan.intro?.priceUSD ?? null, introDurationCycles: plan.intro?.durationCycles ?? null,
    }).map(m => `${plan.name}: ${m}`));
  }
  for (let i = 1; i < sorted.length; i++) problems.push(...validateTierOrder(sorted[i - 1], sorted[i]));
  if (sorted.filter(p => !p.isCustomPricing).length < 1) problems.push('At least one self-serve plan is required.');
  if (problems.length) throw new Error(`Invalid platform plan catalog:\n - ${problems.join('\n - ')}`);
}

// ── Feature bullets — generated from the limits, never typed by hand ─────────

const money = (n: number) => n.toLocaleString('en-US');
const percent = (rate: number) => `${Number((rate * 100).toFixed(2))}%`;

/** The marketing lines for a plan, derived from its real limits so text and enforcement
 *  can never disagree. A plan above another lists "Everything in <lower>" and then only
 *  what is new or bigger; the first plan lists everything. */
export function buildFeatureBullets(
  plan: { limits: PlanLimits },
  previous?: { name: string; limits: PlanLimits } | null,
): string[] {
  const l = plan.limits;
  const p = previous?.limits;
  const lines: string[] = [];
  if (previous) lines.push(`Everything in ${previous.name}, plus:`);

  const changed = (key: NumericKey | 'transactionFeeRate') => !p || p[key] !== l[key];

  if (changed('maxProducts')) lines.push(l.maxProducts === -1 ? 'Unlimited products' : `Up to ${money(l.maxProducts)} products`);
  if (changed('maxStaffAccounts') && l.maxStaffAccounts !== 0) {
    lines.push(l.maxStaffAccounts === -1 ? 'Unlimited staff accounts' : `${money(l.maxStaffAccounts)} staff account${l.maxStaffAccounts === 1 ? '' : 's'}`);
  }
  if (changed('maxPosLocations')) {
    lines.push(l.maxPosLocations === -1 ? 'Unlimited POS & inventory locations' : `${money(l.maxPosLocations)} POS / inventory location${l.maxPosLocations === 1 ? '' : 's'}`);
  }
  if (changed('aiCreditsPerMonth') && l.aiCreditsPerMonth > 0) lines.push(`${money(l.aiCreditsPerMonth)} AI Studio credits every month`);
  if (changed('maxMarkets')) lines.push(l.maxMarkets === -1 ? 'Sell in unlimited currencies' : `Sell in up to ${money(l.maxMarkets)} currencies`);
  if (changed('maxActiveStoreBanners')) lines.push(l.maxActiveStoreBanners === -1 ? 'Unlimited store banners' : `${money(l.maxActiveStoreBanners)} store banners`);
  if (changed('maxActivePromotions')) lines.push(l.maxActivePromotions === -1 ? 'Unlimited active promotions' : `${money(l.maxActivePromotions)} active promotion${l.maxActivePromotions === 1 ? '' : 's'}`);
  for (const { key, label } of FLAG_FEATURES) {
    if (l[key] && !(p && p[key])) lines.push(label);
  }
  if (changed('transactionFeeRate')) lines.push(`${percent(l.transactionFeeRate)} third-party gateway fee`);
  return lines;
}
