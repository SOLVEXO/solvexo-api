/* eslint-disable prettier/prettier */
import { BadRequestException, CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';
import { parseOffline } from '../pos-offline.util';

/** Machine-readable `code` values the POS app switches on (response body: `{ code, message }`). */
export const POS_PLAN_REQUIRED = 'POS_PLAN_REQUIRED';
export const POS_STORE_DISABLED = 'POS_STORE_DISABLED';

/** Store.status values that may not run a POS (pending = awaiting KYC review is still allowed to trade). */
const BLOCKED_STORE_STATUSES = new Set(['suspended', 'rejected']);

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Rollout switch. While `POS_ENTITLEMENT_ENFORCED` is not exactly `'true'` (the default) the guard only
 * LOGS what it would have blocked (warn level: store id + route) and lets the request through, so the
 * existing base of stores can be audited/backfilled before enforcement is turned on. Read per request, so
 * flipping the env var + restarting is the whole rollout.
 */
export const isPosEntitlementEnforced = () => process.env.POS_ENTITLEMENT_ENFORCED === 'true';
const enforced = isPosEntitlementEnforced;

/**
 * Gate for every POS route that *starts or continues selling*: an active POS plan
 * (PosPurchase) is required, and the store must exist and not be suspended/rejected.
 * It replaces the platform-plan trial guard (`BillingAccessGuard`) on POS routes —
 * POS access is governed by the POS plan only.
 *
 * "Active" uses the same rule as PosPlansService.getStatus (the most recent purchase by
 * `purchasedAt` has `expiresAt > now`) so the app's status screen and this enforcement can
 * never disagree.
 *
 * Deliberately NOT applied to PIN login, closing a session, cash adjustments, force-close, refund,
 * void, reads/reports or setup routes — an expired plan must stop selling, never trap cash in an
 * open drawer, lock a cashier out of the till, or block a customer's refund.
 *
 * Unlike BillingAccessGuard this FAILS CLOSED: a request whose store can't be resolved is
 * rejected, never waved through. The store is resolved from `:storeId` / body / query, or —
 * for routes addressed by id — from the session/sale the id belongs to.
 * Ownership is still verified by the service layer; this guard only decides entitlement.
 */
@Injectable()
export class PosEntitlementGuard implements CanActivate {
  private readonly logger = new Logger(PosEntitlementGuard.name);

  constructor(private readonly db: DatabaseService) {}

  /** Throws the block in enforce mode; in report-only mode logs it and lets the request through. */
  private block(req: any, storeId: string, reason: string, exception: ForbiddenException): true {
    if (enforced()) throw exception;
    this.logger.warn(`[report-only] would block ${req.method} ${req.route?.path ?? req.url} — store=${storeId} reason=${reason} (set POS_ENTITLEMENT_ENFORCED=true to enforce)`);
    return true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const storeId = await this.resolveStoreId(req);
    if (!storeId) throw new BadRequestException('storeId is required');

    const r = this.db.repositories;
    const store: any = await r.storeModel.findOne({ _id: storeId, isDelete: false }).select('status').lean();
    // A missing store is never waved through, in either mode: ownership/auth is not a rollout question.
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    if (BLOCKED_STORE_STATUSES.has(store.status)) {
      return this.block(req, storeId, `store ${store.status}`, new ForbiddenException({ statusCode: 403, code: POS_STORE_DISABLED, message: 'This store is not currently allowed to use POS' }));
    }

    // An OFFLINE sale being synced is judged by whether the plan was active when the sale was MADE (its device
    // timestamp), not when it finally reaches us — a sale rung up during an active plan must not be lost because the
    // plan lapsed before the device got a connection. parseOffline also enforces the max offline window and
    // rejects future timestamps (OFFLINE_SALE_TOO_OLD / OFFLINE_SALE_FROM_FUTURE).
    const off = parseOffline(req.body);
    if (off.isOffline) {
      const covering: any = await r.posPurchaseModel.findOne({ storeId, purchasedAt: { $lte: off.at }, expiresAt: { $gt: off.at } }).select('_id').lean();
      if (!covering) {
        return this.block(req, storeId, 'no plan active when the offline sale was made', new ForbiddenException({ statusCode: 403, code: POS_PLAN_REQUIRED, message: 'POS plan was not active when this sale was made' }));
      }
      return true;
    }

    const latest: any = await r.posPurchaseModel.findOne({ storeId }).sort({ purchasedAt: -1 }).select('expiresAt').lean();
    if (!latest || new Date(latest.expiresAt).getTime() <= Date.now()) {
      return this.block(req, storeId, latest ? 'plan expired' : 'no plan', new ForbiddenException({ statusCode: 403, code: POS_PLAN_REQUIRED, message: 'POS plan is not active for this store' }));
    }
    return true;
  }

  private async resolveStoreId(req: any): Promise<string | null> {
    const direct = req.params?.storeId ?? req.body?.storeId ?? req.query?.storeId;
    if (direct !== undefined && direct !== null) return this.asObjectId(direct);

    const r = this.db.repositories;
    if (req.params?.sessionId) {
      const id = this.asObjectId(req.params.sessionId);
      const session: any = await r.registerSessionModel.findById(id).select('storeId').lean();
      return session?.storeId ? String(session.storeId) : null;
    }
    if (req.params?.saleId) {
      const id = this.asObjectId(req.params.saleId);
      const sale: any = await r.saleModel.findById(id).select('storeId').lean();
      return sale?.storeId ? String(sale.storeId) : null;
    }
    return null;
  }

  private asObjectId(value: unknown): string {
    const s = String(value);
    if (!OBJECT_ID.test(s)) throw new BadRequestException('Invalid id');
    return s;
  }
}
