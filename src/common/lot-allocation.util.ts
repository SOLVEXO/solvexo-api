/* eslint-disable prettier/prettier */
import type { ClientSession } from 'mongoose';
import { refreshExpiredStock } from './expired-stock.util';

/**
 * G3.2 (D4): which LOTS a sale / transfer takes units from, and putting them back to the SAME lots on a return.
 *
 * FEFO order: lots with an expiry date, soonest first (not yet expired) → lots with no expiry, oldest received first → (only when `includeExpired`) expired lots, soonest-expired first.
 * An EXPIRED lot is never touched unless the caller passes `includeExpired` — the manager override of the sale route, or an offline sale whose goods already left.
 * Each lot is decremented with a conditional `$inc` (never read-then-$set), so two tills can't take the same unit; units not covered by any lot (stock that predates lot tracking,
 * or an oversold offline sale) come back as `shortBy`. `preview` never writes.
 */
export interface LotAllocation {
  lotId: string;
  lotNumber: string;
  qty: number;
  expiryDate: Date | null;
  expired: boolean;
  /** the lot's own unit cost (minor units, the store currency) when it has one */
  costPriceMinor: number | null;
}
type Repos = { stockLotModel: any; productVariantModel?: any };
interface Opts { session?: ClientSession; now?: Date; includeExpired?: boolean }

const rankOf = (l: any, now: number) => (l.expiryDate && new Date(l.expiryDate).getTime() < now ? 2 : l.expiryDate ? 0 : 1);
const order = (lots: any[], now: number) => lots.sort((a, b) => rankOf(a, now) - rankOf(b, now)
  || (rankOf(a, now) === 1 ? 0 : new Date(a.expiryDate ?? 0).getTime() - new Date(b.expiryDate ?? 0).getTime())
  || new Date(a.receivedAt ?? 0).getTime() - new Date(b.receivedAt ?? 0).getTime());

const toAlloc = (lot: any, qty: number, now: number): LotAllocation => ({
  lotId: String(lot._id), lotNumber: lot.lotNumber, qty, expiryDate: lot.expiryDate ?? null,
  expired: !!lot.expiryDate && new Date(lot.expiryDate).getTime() < now,
  costPriceMinor: lot.costPriceMinor != null ? Number(lot.costPriceMinor) : null,
});

/** What FEFO WOULD take for [qty] units of the variant (no write). Expired lots are listed only when `includeExpired`. */
export async function previewLotsFefo(r: Repos, variantId: string, qty: number, opts: Opts = {}): Promise<{ allocations: LotAllocation[]; shortBy: number }> {
  const now = (opts.now ?? new Date()).getTime();
  const lots: any[] = await r.stockLotModel.find({ variantId, status: 'active', quantityRemaining: { $gt: 0 } }).session(opts.session ?? null).lean();
  const usable = order(lots.filter((l) => opts.includeExpired || rankOf(l, now) !== 2), now);
  let left = qty;
  const allocations: LotAllocation[] = [];
  for (const l of usable) {
    if (left <= 0) break;
    const take = Math.min(l.quantityRemaining, left);
    allocations.push(toAlloc(l, take, now));
    left -= take;
  }
  return { allocations, shortBy: Math.max(0, left) };
}

/** Takes [qty] units from the variant's lots in FEFO order; returns what was taken and what no lot could cover. */
export async function allocateLotsFefo(r: Repos, variantId: string, qty: number, opts: Opts = {}): Promise<{ allocations: LotAllocation[]; shortBy: number }> {
  const now = (opts.now ?? new Date()).getTime();
  let left = qty;
  const taken = new Map<string, LotAllocation>();
  for (let pass = 0; pass < 4 && left > 0; pass++) {
    const lots: any[] = await r.stockLotModel.find({ variantId, status: 'active', quantityRemaining: { $gt: 0 } }).session(opts.session ?? null).lean();
    const usable = order(lots.filter((l) => opts.includeExpired || rankOf(l, now) !== 2), now);
    if (!usable.length) break;
    for (const lot of usable) {
      if (left <= 0) break;
      const take = Math.min(lot.quantityRemaining, left);
      const res = await r.stockLotModel.findOneAndUpdate({ _id: lot._id, status: 'active', quantityRemaining: { $gte: take } }, { $inc: { quantityRemaining: -take } }, { new: true, session: opts.session });
      if (!res) continue; // lost a race on this lot — the next pass re-reads
      left -= take;
      const prev = taken.get(String(lot._id));
      if (prev) prev.qty += take; else taken.set(String(lot._id), toAlloc(lot, take, now));
      if ((res as any).quantityRemaining <= 0) await r.stockLotModel.updateOne({ _id: lot._id, quantityRemaining: { $lte: 0 } }, { $set: { status: 'depleted' } }, { session: opts.session });
    }
  }
  await refreshExpiredStock(r, variantId, { session: opts.session, now: opts.now });
  return { allocations: [...taken.values()], shortBy: Math.max(0, left) };
}

/** Puts units back into the lots they came from (a failed sale, a void, a return). A depleted lot is active again; a lot that no longer exists is skipped (returned list = what could not go back). */
export async function restoreToLots(r: Repos, variantId: string, parts: Array<{ lotId: string; qty: number }>, opts: { session?: ClientSession; now?: Date } = {}): Promise<Array<{ lotId: string; qty: number }>> {
  const missing: Array<{ lotId: string; qty: number }> = [];
  for (const p of parts) {
    if (!(p.qty > 0)) continue;
    await r.stockLotModel.updateOne({ _id: p.lotId, status: 'depleted' }, { $set: { status: 'active' } }, { session: opts.session });
    const res = await r.stockLotModel.updateOne({ _id: p.lotId }, { $inc: { quantityRemaining: p.qty } }, { session: opts.session });
    if (!(res as any).matchedCount) missing.push(p);
  }
  await refreshExpiredStock(r, variantId, { session: opts.session, now: opts.now });
  return missing;
}

/**
 * A line sold from lots [allocations] (in the order taken) had [returnedBefore] units returned already; the next [qty] returned units map onto the allocations in the
 * order they were sold (cumulative, deterministic — no extra counter): which lot do these units go back to?
 */
export function returnPartsFor(allocations: Array<{ lotId: string; qty: number }>, returnedBefore: number, qty: number): Array<{ lotId: string; qty: number }> {
  const out: Array<{ lotId: string; qty: number }> = [];
  let skip = returnedBefore;
  let want = qty;
  for (const a of allocations) {
    if (want <= 0) break;
    const avail = Math.max(0, a.qty - Math.max(0, Math.min(skip, a.qty)));
    skip = Math.max(0, skip - a.qty);
    if (avail <= 0) continue;
    const take = Math.min(avail, want);
    out.push({ lotId: a.lotId, qty: take });
    want -= take;
  }
  return out;
}
