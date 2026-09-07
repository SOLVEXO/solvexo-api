/* eslint-disable prettier/prettier */
import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DatabaseService } from '@/database/databaseservice';
import { REQUIRE_ACTIVE_BILLING_KEY } from '../decorators/require-active-billing.decorator';

/**
 * Centralized billing-status gate — the single place that ever checks
 * `SellerPlatformSubscription.status === 'locked'`, so this never needs to
 * be scattered as `if (status === 'locked')` across individual controllers.
 * A `'locked'` store keeps every other route working (login, account,
 * billing, plan selection, payment) — this guard only blocks the specific
 * routes explicitly opted in via `@RequireActiveBilling()` (product
 * create/edit, checkout/place-order). No data is touched here; this is
 * pure request-time access control.
 */
@Injectable()
export class BillingAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_ACTIVE_BILLING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true; // no @RequireActiveBilling() on this route

    const req = context.switchToHttp().getRequest();
    // Covers both a seller-dashboard mutation (storeId in the URL) and a
    // buyer checkout (storeId in the body) — whichever shape the route uses.
    const storeId: string | undefined = req.params?.storeId ?? req.body?.storeId ?? req.query?.storeId;
    if (!storeId) return true; // can't resolve which store — fail open rather than break an unrelated route

    const sub = await this.db.repositories.sellerPlatformSubscriptionModel
      .findOne({ storeId, isDelete: false })
      .select('status')
      .lean();

    if (sub && (sub as any).status === 'locked') {
      throw new ForbiddenException(
        'This store is currently locked — choose a plan and complete payment from the billing page to resume selling.',
      );
    }
    return true;
  }
}
