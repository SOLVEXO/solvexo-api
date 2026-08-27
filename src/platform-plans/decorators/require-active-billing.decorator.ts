/* eslint-disable prettier/prettier */
import { SetMetadata } from '@nestjs/common';

export const REQUIRE_ACTIVE_BILLING_KEY = 'requireActiveBilling';

/**
 * Gate a controller/route behind the target store's billing status — see
 * `BillingAccessGuard`. Apply ONLY to routes that represent "normal
 * selling/checkout operations" (creating/editing products, placing an
 * order) — never to auth, billing/account, or read-only routes, which must
 * stay reachable so a locked seller can pay and unlock. Mirrors the
 * existing `@RequireFeature()`/`FeatureFlagGuard` pattern in `admin-config/`.
 */
export const RequireActiveBilling = () => SetMetadata(REQUIRE_ACTIVE_BILLING_KEY, true);
