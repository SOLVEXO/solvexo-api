/* eslint-disable prettier/prettier */
import type { ClientSession } from 'mongoose';
import { refreshExpiredStock } from './expired-stock.util';

/**
 * FEFO/FIFO lot consumption shared by every path that makes units leave a lot-tracked variant (sale shipment, manual
 * reduction, supplier return). Order: lots that expire soonest first (not-yet-expired), then lots with no expiry (oldest
 * received first), and already-expired lots LAST — they are for write-off, not for selling, but still serve as the cost
 * source if nothing else is left. (The old inline copies sorted `expiryDate: 1`, which in Mongo puts lots WITHOUT an
 * expiry first, so non-perishable lots were drained before perishable ones.)
 *
 * Each lot is decremented with a conditional `$inc` (never read-then-$set), so concurrent consumers can't double-take a
 * unit. Returns the total cost of what was consumed, or null when the variant has no lot with stock at all.
 */
export async function consumeLots(
  r: { stockLotModel: any; productVariantModel?: any },
  variantId: string,
  quantity: number,
  opts: { session?: ClientSession; now?: Date } = {},
): Promise<number | null> {
  const { session } = opts;
  const now = (opts.now ?? new Date()).getTime();
  let remaining = quantity;
  let totalCost = 0;
  let found = false;

  for (let pass = 0; pass < 4 && remaining > 0; pass++) {
    const lots: any[] = await r.stockLotModel.find({ variantId, status: 'active', quantityRemaining: { $gt: 0 } }).session(session ?? null).lean();
    if (lots.length === 0) break;
    found = true;
    const rank = (l: any) => (l.expiryDate && new Date(l.expiryDate).getTime() < now ? 2 : l.expiryDate ? 0 : 1);
    lots.sort((a, b) => rank(a) - rank(b)
      || (rank(a) === 0 ? new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime() : 0)
      || new Date(a.receivedAt ?? 0).getTime() - new Date(b.receivedAt ?? 0).getTime());
    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(lot.quantityRemaining, remaining);
      const res = await r.stockLotModel.findOneAndUpdate(
        { _id: lot._id, status: 'active', quantityRemaining: { $gte: take } },
        { $inc: { quantityRemaining: -take } },
        { new: true, session },
      );
      if (!res) continue; // lost a race on this lot — the next pass re-reads
      totalCost += take * lot.costPrice;
      remaining -= take;
      if ((res as any).quantityRemaining <= 0) {
        await r.stockLotModel.updateOne({ _id: lot._id, quantityRemaining: { $lte: 0 } }, { $set: { status: 'depleted' } }, { session });
      }
    }
  }
  if (!found) return null;
  await refreshExpiredStock(r, variantId, { session, now: opts.now });
  return Math.round(totalCost * 100) / 100;
}
