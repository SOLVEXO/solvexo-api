/* eslint-disable prettier/prettier */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isValidObjectId } from 'mongoose';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { STAFF_STORE_PINNED_KEY } from '../decorators/staff-store-pinned.decorator';
import { DatabaseService } from '../../database/databaseservice';

const NOT_SCOPED = 'This staff account is not scoped to that store';

/** Enforces `@RequirePermission(...)` — but ONLY for `role:'staff'`. A
 *  seller/admin caller always passes unconditionally (they own everything;
 *  permissions exist purely to restrict a staff identity, never the
 *  owner's own access) — this mirrors how `RolesGuard` already treats
 *  'seller'/'admin' as always-privileged on every Inventory/Purchase-Order/
 *  Stock-Count route. Must run AFTER `JwtAuthGuard` (needs `request.user`)
 *  — same guard-ordering convention as every other `@UseGuards(JwtAuthGuard,
 *  RolesGuard, ...)` stack in this codebase.
 *
 *  Store pinning for a staff caller (a staff login belongs to ONE store: `user.storeId`, see
 *  StaffMember/JwtStrategy — its owning seller may have other stores it must never touch):
 *   1. any `storeId` the request carries (route param, query or body) must equal `user.storeId`;
 *   2. any resource id the request carries (product, variant, order, conversation, message, saved report)
 *      must belong to `user.storeId` — covers the routes that have no `:storeId` at all;
 *   3. routes marked `@StaffStorePinned()` that carry no store id at all are pinned by injecting
 *      `query.storeId = user.storeId`.
 *  A seller/admin caller has no such restriction — store ownership itself is checked separately inside each
 *  service method (e.g. `storeModel.findOne({_id, sellerId})`). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector, private db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    const hasRequired = !!required && required.length > 0;
    if (!hasRequired && !user) return true; // nothing to enforce, and no identity to pin
    if (!user) throw new ForbiddenException('Access Denied');
    if (user.role !== 'staff') return true; // seller/admin — always allowed

    await this.pinStaffToStore(request, user, context);

    if (!hasRequired) return true;
    const permissions: string[] = Array.isArray(user.permissions) ? user.permissions : [];
    const hasAny = required.some((p) => permissions.includes(p));
    if (!hasAny) {
      throw new ForbiddenException(
        `Your staff account doesn't have permission to do this (requires: ${required.join(' or ')})`,
      );
    }
    return true;
  }

  private async pinStaffToStore(request: any, user: any, context: ExecutionContext) {
    const staffStoreId = user.storeId ? String(user.storeId) : null;
    if (!staffStoreId) throw new ForbiddenException(NOT_SCOPED);

    // 1) explicit store ids — a non-string (array/object operator) is never a legitimate store id
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    let sawStoreId = false;
    for (const v of [request.params?.storeId, request.query?.storeId, body.storeId]) {
      if (v === undefined || v === null || v === '') continue;
      sawStoreId = true;
      if (typeof v !== 'string' || v !== staffStoreId) throw new ForbiddenException(NOT_SCOPED);
    }

    // 2) resource ids → must belong to the staff member's own store
    const path: string = request.route?.path ?? request.path ?? '';
    const p = request.params ?? {};
    const checks: Promise<void>[] = [];
    const productId = p.productId ?? body.productId;
    if (productId) checks.push(this.assertProduct(productId, staffStoreId));
    if (p.variantId) checks.push(this.assertVariant(p.variantId, staffStoreId));
    const orderId = p.orderId ?? body.orderId;
    if (orderId) checks.push(this.assertOrder(orderId, staffStoreId));
    if (p.convId) checks.push(this.assertConversation(p.convId, staffStoreId));
    if (p.id && path.includes('messages')) checks.push(this.assertMessage(p.id, staffStoreId));
    else if (p.id && path.includes('conversations')) checks.push(this.assertConversation(p.id, staffStoreId));
    if (p.reportId) checks.push(this.assertSavedReport(p.reportId, staffStoreId));
    await Promise.all(checks);

    // 3) store-less routes marked @StaffStorePinned → pin to the staff member's store
    const pinned = this.reflector.getAllAndOverride<boolean>(STAFF_STORE_PINNED_KEY, [context.getHandler(), context.getClass()]);
    if (pinned && !sawStoreId) {
      // Express 5: `req.query` is a getter (re-parsed on every read), so mutating it is lost — redefine it.
      Object.defineProperty(request, 'query', {
        value: { ...(request.query ?? {}), storeId: staffStoreId },
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }
  }

  /** A malformed id or a missing document is left to the handler (404 there) — only a document that EXISTS and
   *  belongs to ANOTHER store is refused. */
  private async find(model: any, id: any, select: string): Promise<any | null> {
    if (typeof id !== 'string' || !isValidObjectId(id)) return null;
    return model.findById(id).select(select).lean();
  }

  private async assertProduct(productId: any, staffStoreId: string) {
    const doc = await this.find(this.db.repositories.productModel, productId, 'storeId');
    if (doc && String(doc.storeId) !== staffStoreId) throw new ForbiddenException(NOT_SCOPED);
  }

  private async assertVariant(variantId: any, staffStoreId: string) {
    const v = await this.find(this.db.repositories.productVariantModel, variantId, 'productId');
    if (v?.productId) await this.assertProduct(String(v.productId), staffStoreId);
  }

  private async assertOrder(orderId: any, staffStoreId: string) {
    const o = await this.find(this.db.repositories.orderModel, orderId, 'sellerOrders.storeId');
    if (o && !(o.sellerOrders ?? []).some((so: any) => String(so.storeId) === staffStoreId)) {
      throw new ForbiddenException(NOT_SCOPED);
    }
  }

  private async assertConversation(convId: any, staffStoreId: string) {
    const c = await this.find(this.db.repositories.conversationModel, convId, 'storeId');
    if (c && String(c.storeId) !== staffStoreId) throw new ForbiddenException(NOT_SCOPED);
  }

  private async assertMessage(messageId: any, staffStoreId: string) {
    const m = await this.find(this.db.repositories.messageModel, messageId, 'conversationId');
    if (m?.conversationId) await this.assertConversation(String(m.conversationId), staffStoreId);
  }

  private async assertSavedReport(reportId: any, staffStoreId: string) {
    const r = await this.find(this.db.repositories.savedReportModel, reportId, 'storeId');
    if (r && String(r.storeId) !== staffStoreId) throw new ForbiddenException(NOT_SCOPED);
  }
}
