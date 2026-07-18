/* eslint-disable prettier/prettier */
import { StorePlan } from '../../store/schemas/store.schema';

/**
 * Platform tier definitions — sellers pay THE MARKETPLACE for these (distinct
 * from `src/subscriptions`, where a seller sells plans TO their own buyers).
 *
 * No admin UI exists to edit these yet (confirmed — zero admin-facing screens
 * anywhere in the app), so this is backend-defined config for v1, not a DB
 * table. It's still exposed read-only via `GET tiers` / `GET admin/tiers`, and
 * a store's tier CAN be overridden by an admin (see `adminOverrideStoreTier`)
 * without needing to edit this file — only pricing/limits themselves require
 * a code change.
 *
 * Limits below are reasonable defaults, not confirmed real numbers — adjust
 * freely, nothing depends on the exact values beyond this file and the
 * product-limit check in `products.service.ts`.
 */
export interface PlatformTierConfig {
  tier: StorePlan;
  name: string;
  monthlyPriceUSD: number;
  yearlyPriceUSD: number | null; // null only for the free tier
  /** null = unlimited */
  productLimit: number | null;
  /** Whether a store on this tier may purchase the separate $29/mo POS add-on. */
  posEligible: boolean;
  features: string[];
}

export const PLATFORM_TIERS: Record<StorePlan, PlatformTierConfig> = {
  [StorePlan.STARTER]: {
    tier: StorePlan.STARTER,
    name: 'Starter',
    monthlyPriceUSD: 0,
    yearlyPriceUSD: null,
    productLimit: 10,
    posEligible: false,
    features: ['Up to 10 products', 'Marketplace listing', 'AI Studio (basic)'],
  },
  [StorePlan.BASIC]: {
    tier: StorePlan.BASIC,
    name: 'Basic',
    monthlyPriceUSD: 19,
    yearlyPriceUSD: 190, // ~2 months free
    productLimit: 50,
    posEligible: true,
    features: ['Up to 50 products', 'POS add-on eligible', 'Priority support'],
  },
  [StorePlan.PRO]: {
    tier: StorePlan.PRO,
    name: 'Pro',
    monthlyPriceUSD: 49,
    yearlyPriceUSD: 490,
    productLimit: 250,
    posEligible: true,
    features: ['Up to 250 products', 'POS add-on eligible', 'Advanced analytics'],
  },
  [StorePlan.ENTERPRISE]: {
    tier: StorePlan.ENTERPRISE,
    name: 'Enterprise',
    monthlyPriceUSD: 149,
    yearlyPriceUSD: 1490,
    productLimit: null,
    posEligible: true,
    features: ['Unlimited products', 'POS add-on eligible', 'Dedicated support'],
  },
};

export const POS_ADDON_MONTHLY_PRICE_USD = 29;

// Ordered lowest → highest, for upgrade/downgrade comparisons.
export const TIER_ORDER: StorePlan[] = [
  StorePlan.STARTER, StorePlan.BASIC, StorePlan.PRO, StorePlan.ENTERPRISE,
];

export function isTierAtLeast(tier: StorePlan, minimum: StorePlan): boolean {
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minimum);
}
