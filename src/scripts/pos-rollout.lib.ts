/**
 * Core logic for the POS-plan rollout scripts (`pos-plan-backfill.ts`, `pos-preflight-open-sessions.ts`).
 * Kept in a plain module that takes a mongodb `Db`, so it can be exercised against a real in-memory Mongo
 * in tests while the scripts themselves stay thin CLI wrappers.
 *
 * Everything here is READ-ONLY except `grantStores`, which only ever INSERTS (a manual PosPurchase row and
 * an audit-log row per store) — it never edits or deletes an existing document.
 */
import type { Db } from 'mongodb';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StoreUsingPosWithoutPlan {
  storeId: string;
  storeName: string | null;
  sellerId: string | null;
  storeStatus: string | null;
  sessions: number;
  sales: number;
  lastActivityAt: Date | null;
  /** Why the store has no active plan: never bought one, or its latest plan expired. */
  planState: 'none' | 'expired';
  lastPlanExpiredAt: Date | null;
}

/** storeId → how much POS activity it has (any session or any POS sale counts as "has used POS"). */
async function posActivityByStore(db: Db): Promise<Map<string, { sessions: number; sales: number; last: Date | null }>> {
  const map = new Map<string, { sessions: number; sales: number; last: Date | null }>();
  const bump = (id: string, key: 'sessions' | 'sales', n: number, last: Date | null) => {
    const cur = map.get(id) ?? { sessions: 0, sales: 0, last: null };
    cur[key] += n;
    if (last && (!cur.last || last > cur.last)) cur.last = last;
    map.set(id, cur);
  };
  const groups = [
    { collection: 'registersessions', key: 'sessions' as const },
    { collection: 'sales', key: 'sales' as const },
  ];
  for (const g of groups) {
    const rows = await db.collection(g.collection).aggregate([
      { $match: { storeId: { $type: 'string' } } },
      { $group: { _id: '$storeId', n: { $sum: 1 }, last: { $max: '$createdAt' } } },
    ]).toArray();
    for (const r of rows) bump(String(r._id), g.key, r.n, r.last ?? null);
  }
  return map;
}

/** Stores that have used POS and whose latest PosPurchase (by purchasedAt) is missing or expired. Read-only. */
export async function findStoresUsingPosWithoutPlan(db: Db, now: Date = new Date()): Promise<StoreUsingPosWithoutPlan[]> {
  const activity = await posActivityByStore(db);
  if (activity.size === 0) return [];

  const latest = await db.collection('pospurchases').aggregate([
    { $sort: { purchasedAt: -1 } },
    { $group: { _id: '$storeId', expiresAt: { $first: '$expiresAt' } } },
  ]).toArray();
  const latestExpiry = new Map<string, Date>(latest.map((r) => [String(r._id), r.expiresAt as Date]));

  const out: StoreUsingPosWithoutPlan[] = [];
  const ids = [...activity.keys()];
  // Store _ids are ObjectIds; session/sale storeIds are their string form.
  const { ObjectId: OID } = await import('mongodb');
  const objectIds = ids.filter((i) => /^[a-f0-9]{24}$/i.test(i)).map((i) => new OID(i));
  const storeDocs = await db.collection('stores').find({ _id: { $in: objectIds } }).project({ name: 1, sellerId: 1, status: 1, isDelete: 1 }).toArray();
  const storeById = new Map(storeDocs.map((s) => [String(s._id), s]));

  for (const [storeId, a] of activity) {
    const store = storeById.get(storeId);
    if (!store || store.isDelete === true) continue; // orphaned / deleted store: nothing to grant
    const expiry = latestExpiry.get(storeId);
    if (expiry && expiry.getTime() > now.getTime()) continue; // already has an active plan
    out.push({
      storeId,
      storeName: store.name ?? null,
      sellerId: store.sellerId ?? null,
      storeStatus: store.status ?? null,
      sessions: a.sessions,
      sales: a.sales,
      lastActivityAt: a.last,
      planState: expiry ? 'expired' : 'none',
      lastPlanExpiredAt: expiry ?? null,
    });
  }
  return out.sort((x, y) => (y.lastActivityAt?.getTime() ?? 0) - (x.lastActivityAt?.getTime() ?? 0));
}

export interface GrantOptions { days: number; reason: string; actorId: string; now?: Date }

/**
 * Grants `days` days to each store — INSERT-only, and idempotent: a store that has an active plan by the time
 * its turn comes (a re-run, or a purchase made meanwhile) is skipped, never extended or duplicated.
 */
export async function grantStores(db: Db, stores: StoreUsingPosWithoutPlan[], opts: GrantOptions) {
  const { ObjectId: OID } = await import('mongodb');
  const now = opts.now ?? new Date();
  const granted: string[] = [];
  const skipped: string[] = [];
  for (const s of stores) {
    const latest = await db.collection('pospurchases').find({ storeId: s.storeId }).sort({ purchasedAt: -1 }).limit(1).next();
    if (latest && (latest.expiresAt as Date).getTime() > now.getTime()) { skipped.push(s.storeId); continue; }
    const expiresAt = new Date(now.getTime() + opts.days * DAY_MS);
    await db.collection('pospurchases').insertOne({
      storeId: s.storeId,
      sellerId: s.sellerId ?? '',
      planId: 'manual',
      planNameSnapshot: 'Manual grant',
      priceSnapshot: 0,
      currencySnapshot: 'USD',
      durationInDaysSnapshot: opts.days,
      stripeCheckoutSessionId: `manual:${new OID()}`,
      stripePaymentIntentId: null,
      purchasedAt: now,
      expiresAt,
      source: 'manual',
      grantedByAdminId: opts.actorId,
      grantReason: opts.reason,
      revokedAt: null, revokedByAdminId: null, revokeReason: null,
      createdAt: now, updatedAt: now,
    });
    await db.collection('activitylogs').insertOne({
      storeId: s.storeId,
      actorId: opts.actorId, actorName: opts.actorId, actorRole: 'admin',
      category: 'admin_audit', action: 'pos_plan_granted',
      description: `POS plan granted to "${s.storeName ?? s.storeId}" for ${opts.days} day(s): ${opts.reason}`,
      targetId: s.storeId, targetType: 'store', ip: null, userAgent: null, isSecurityAlert: false,
      metadata: { days: opts.days, reason: opts.reason, expiresAt, adminId: opts.actorId, via: 'pos-plan-backfill' },
      createdAt: now, updatedAt: now,
    });
    granted.push(s.storeId);
  }
  return { granted, skipped };
}

export interface DuplicateOpenSessions {
  registerId: string;
  storeId: string;
  openSessions: Array<{ sessionId: string; employeeId: string; openedAt: Date | null; totalSales: number; cashSales: number }>;
}

/**
 * Registers with MORE THAN ONE `open` session. The unique partial index
 * `uniq_open_session_per_register` (registerId + status:'open') cannot be built while any exist, so each
 * must be closed (force-close from the app, or the admin tooling) first. Read-only.
 */
export async function findDuplicateOpenSessions(db: Db): Promise<DuplicateOpenSessions[]> {
  const rows = await db.collection('registersessions').aggregate([
    { $match: { status: 'open' } },
    { $sort: { openedAt: 1 } },
    {
      $group: {
        _id: '$registerId',
        storeId: { $first: '$storeId' },
        count: { $sum: 1 },
        sessions: { $push: { sessionId: { $toString: '$_id' }, employeeId: '$employeeId', openedAt: '$openedAt', totalSales: { $ifNull: ['$totalSales', 0] }, cashSales: { $ifNull: ['$cashSales', 0] } } },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  return rows.map((r) => ({ registerId: String(r._id), storeId: String(r.storeId), openSessions: r.sessions }));
}
