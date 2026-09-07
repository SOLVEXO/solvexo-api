/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';

/**
 * Every buyer-facing endpoint that touches store-scoped data (cart, checkout,
 * ...) must resolve its storeId through this, not by trusting a client-sent
 * value on its own. `req.user.storeId` (from the JWT, itself resolved
 * server-side from the account's own DB record — see JwtStrategy/AuthService)
 * is the source of truth for a store-scoped buyer account: it can never be
 * spoofed by the client, so a mismatch means the request is trying to read or
 * write another store's data under this identity and must be rejected.
 *
 * `userStoreId` is `null` only for the legacy apex-wide buyer account (pre-
 * dates per-store identity, see `User.storeId`'s schema comment) — that
 * account genuinely shops across stores by design, so for it the
 * client-supplied storeId is still trusted as-is (unchanged prior behavior).
 */
export function resolveBuyerStoreScope(
  userStoreId: string | null | undefined,
  requestedStoreId: string | null | undefined,
): string {
  if (userStoreId) {
    if (requestedStoreId && String(requestedStoreId) !== String(userStoreId)) {
      throw new ForbiddenException("storeId does not match this account's store");
    }
    return String(userStoreId);
  }
  if (!requestedStoreId) throw new BadRequestException('storeId is required');
  return String(requestedStoreId);
}
