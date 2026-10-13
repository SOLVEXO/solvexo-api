/* eslint-disable prettier/prettier */
import type { ClientSession } from 'mongoose';

/**
 * Expired lot units are not sellable — and the moment a lot's expiry date passes, not at the next job run.
 *
 * Availability is evaluated inside atomic Mongo filters on the variant document (`AVAILABLE_STOCK_EXPR`), which cannot read
 * lots. So two small facts about a variant's lots are kept ON the variant document:
 *   • `expiredStock`   — units in lots whose expiry date has ALREADY passed (as of the last refresh);
 *   • `expiryBuckets`  — the next upcoming expiries: `[{ at, units }]`, earliest first (capped at MAX_BUCKETS).
 * `AVAILABLE_STOCK_EXPR` subtracts `expiredStock` plus every bucket whose `at` is <= the database clock (`$$NOW`), so a lot
 * that expires between refreshes stops being allocatable exactly at its expiry time. Both fields are always written together
 * from the same instant, so a unit is never counted twice; the 5-minute cron and every lot change just re-sort the buckets.
 * (Only a lot beyond the MAX_BUCKETS-th upcoming expiry of one variant waits for the next refresh — at most 5 minutes.)
 */
export const MAX_EXPIRY_BUCKETS = 30;

type Repos = { stockLotModel: any; productVariantModel?: any };
export interface ExpiryState { expiredStock: number; expiryBuckets: { at: Date; units: number }[] }

/** Pure: lots of ONE variant -> the state stored on the variant. */
export function computeExpiryState(lots: { expiryDate?: Date | string | null; quantityRemaining: number }[], now: Date): ExpiryState {
  let expired = 0;
  const future: { at: Date; units: number }[] = [];
  for (const l of lots) {
    if (!l.expiryDate || !(l.quantityRemaining > 0)) continue;
    const at = new Date(l.expiryDate);
    if (at.getTime() < now.getTime()) expired += l.quantityRemaining;
    else future.push({ at, units: l.quantityRemaining });
  }
  future.sort((a, b) => a.at.getTime() - b.at.getTime());
  return { expiredStock: expired, expiryBuckets: future.slice(0, MAX_EXPIRY_BUCKETS) };
}

/** Recomputes one variant's expiry state from its active lots. */
export async function refreshExpiredStock(r: Repos, variantId: string, opts: { session?: ClientSession; now?: Date } = {}): Promise<number> {
  if (!r.productVariantModel) return 0;
  const now = opts.now ?? new Date();
  const lots: any[] = await r.stockLotModel
    .find({ variantId, status: 'active', quantityRemaining: { $gt: 0 }, expiryDate: { $ne: null } })
    .session(opts.session ?? null).lean();
  const state = computeExpiryState(lots, now);
  await r.productVariantModel.updateOne({ _id: variantId }, { $set: state }, { session: opts.session });
  return state.expiredStock;
}

/** Cron entry: refreshes every variant that has dated lots, and clears variants that no longer have any. */
export async function refreshAllExpiredStock(r: Repos, now = new Date()): Promise<{ updated: number; cleared: number }> {
  if (!r.productVariantModel) return { updated: 0, cleared: 0 };
  const rows: any[] = await r.stockLotModel
    .find({ status: 'active', quantityRemaining: { $gt: 0 }, expiryDate: { $ne: null } })
    .select('variantId expiryDate quantityRemaining').lean();
  const byVariant = new Map<string, any[]>();
  for (const l of rows) { const a = byVariant.get(l.variantId) ?? []; a.push(l); byVariant.set(l.variantId, a); }
  const ops: any[] = [];
  for (const [variantId, lots] of byVariant) {
    ops.push({ updateOne: { filter: { _id: variantId }, update: { $set: computeExpiryState(lots, now) } } });
  }
  let updated = 0;
  for (let i = 0; i < ops.length; i += 500) {
    const res = await r.productVariantModel.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    updated += res.modifiedCount ?? 0;
  }
  const cleared = await r.productVariantModel.updateMany(
    { _id: { $nin: [...byVariant.keys()] }, $or: [{ expiredStock: { $gt: 0 } }, { 'expiryBuckets.0': { $exists: true } }] },
    { $set: { expiredStock: 0, expiryBuckets: [] } },
  );
  return { updated, cleared: cleared.modifiedCount ?? 0 };
}
