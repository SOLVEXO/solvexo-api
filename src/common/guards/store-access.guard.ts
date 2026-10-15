import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipOrForbidden } from '@/common/store-ownership.util';

/**
 * For routes shaped `.../:storeId/...`: the caller must really own that store.
 * - seller: the store's `sellerId` must be the caller (shared `verifyStoreOwnershipOrForbidden`);
 * - staff: pinned to its own store (PermissionsGuard pins too — this is the fail-closed duplicate for routes that
 *   forgot the permission decorator);
 * - anyone else (buyer, admin) is refused here — a route that also wants admins must not use this guard.
 * Must run AFTER JwtAuthGuard (needs `request.user`).
 */
@Injectable()
export class StoreAccessGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const storeId = request.params?.storeId;
    if (!user || typeof storeId !== 'string' || !isValidObjectId(storeId)) {
      throw new ForbiddenException('Store not found or unauthorized');
    }
    if (user.role === 'staff') {
      if (user.storeId !== storeId) throw new ForbiddenException('This staff account is not scoped to that store');
      return true;
    }
    if (user.role !== 'seller') throw new ForbiddenException('Store not found or unauthorized');
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel, storeId, user.userId);
    return true;
  }
}
