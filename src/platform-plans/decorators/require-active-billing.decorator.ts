/* eslint-disable prettier/prettier */
import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTIVE_BILLING_KEY = 'requireActiveBilling';

export interface RequireActiveBillingOptions {
  /**
   * Also block a genuinely `trialing` store, not just `locked`/`trial_ended`
   * — for real customer checkout/order-placement ONLY. Verified against
   * Shopify's own real trial: a standard trial's checkout stays disabled
   * ("private mode") until a plan is chosen, even though the trial store
   * can otherwise be fully built (unlimited products, staff, etc. — see
   * `EntitlementsService.applyTrialOverride`). Never set this on a
   * product/staff/store-building route — Shopify explicitly allows those
   * during trial, and this project's trial deliberately mirrors that.
   */
  blockDuringTrial?: boolean;

  /**
   * Who actually sees the resulting error — real gap fixed: `blockDuringTrial`
   * alone can't tell a genuinely buyer-facing route (checkout) apart from a
   * seller-facing one that ALSO sets it (POS, run by the seller's own
   * cashier) — both used the same seller-oriented "choose a plan from the
   * billing page" wording, which made no sense on a BUYER's checkout error.
   * Default `'seller'` (byte-identical to the previous behavior) — only
   * checkout should ever pass `'buyer'`.
   */
  audience?: 'buyer' | 'seller';
}

/**
 * Gate a controller/route behind the target store's billing status — see
 * `BillingAccessGuard`. Apply ONLY to routes that represent "normal
 * selling/checkout operations" (creating/editing products, placing an
 * order) — never to auth, billing/account, or read-only routes, which must
 * stay reachable so a locked seller can pay and unlock. Mirrors the
 * existing `@RequireFeature()`/`FeatureFlagGuard` pattern in `admin-config/`.
 */
export const RequireActiveBilling = (options: RequireActiveBillingOptions = {}) =>
  SetMetadata(REQUIRE_ACTIVE_BILLING_KEY, options);
