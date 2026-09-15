/* eslint-disable prettier/prettier */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';

/** Enforces `@RequirePermission(...)` — but ONLY for `role:'staff'`. A
 *  seller/admin caller always passes unconditionally (they own everything;
 *  permissions exist purely to restrict a staff identity, never the
 *  owner's own access) — this mirrors how `RolesGuard` already treats
 *  'seller'/'admin' as always-privileged on every Inventory/Purchase-Order/
 *  Stock-Count route. Must run AFTER `JwtAuthGuard` (needs `request.user`)
 *  — same guard-ordering convention as every other `@UseGuards(JwtAuthGuard,
 *  RolesGuard, ...)` stack in this codebase.
 *
 *  Also enforces store-scoping for a staff caller: `user.storeId` (the
 *  ONE store this staff login belongs to — see StaffMember/JwtStrategy)
 *  must match the route's own `:storeId` param, so a valid staff token for
 *  Store A can never be pointed at Store B's inventory even with a
 *  correctly-shaped request. A seller/admin caller has no such
 *  restriction — store ownership itself is checked separately inside each
 *  service method (e.g. `storeModel.findOne({_id, sellerId})`). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) throw new ForbiddenException('Access Denied');
    if (user.role !== 'staff') return true; // seller/admin — always allowed

    const routeStoreId = request.params?.storeId;
    if (routeStoreId && user.storeId !== routeStoreId) {
      throw new ForbiddenException('This staff account is not scoped to that store');
    }

    const permissions: string[] = Array.isArray(user.permissions) ? user.permissions : [];
    const hasAny = required.some((p) => permissions.includes(p));
    if (!hasAny) {
      throw new ForbiddenException(
        `Your staff account doesn't have permission to do this (requires: ${required.join(' or ')})`,
      );
    }
    return true;
  }
}
