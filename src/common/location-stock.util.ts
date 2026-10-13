/* eslint-disable prettier/prettier */
import type { ClientSession } from 'mongoose';

/**
 * `ProductVariant.stock` is the store-wide on-hand total; once a variant has `VariantLocationStock` rows, those rows must add
 * up to it (plus whatever is in transit). Every code path that moves on-hand units (a shipped order, a POS sale, a draft order,
 * a cancelled draft order, a refund) used to touch only the variant total, so per-location quantities drifted away from reality
 * after the first sale. These two helpers apply the SAME movement to the location rows. Both are no-ops for variants that have
 * no location rows (single-location stores), and both are floor-guarded (never below 0).
 *
 * `r` is `databaseService.repositories` (needs `variantLocationStockModel`, and `storeLocationModel` for restore).
 */
type Repos = { variantLocationStockModel: any; storeLocationModel?: any };

/** Removes `qty` units from the variant's location rows: `preferLocationId` first (e.g. the register's location), then the row
 *  holding the most stock. Returns how many units were taken from location rows (may be < qty if rows hold less than the total,
 *  e.g. units that are in transit — the caller's variant-level total stays authoritative). */
export async function drainLocationStock(
  r: Repos,
  variantId: string,
  qty: number,
  opts: { preferLocationId?: string | null; session?: ClientSession } = {},
): Promise<number> {
  if (!(qty > 0)) return 0;
  const { session } = opts;
  let rows: any[] = await r.variantLocationStockModel.find({ variantId }).session(session ?? null).lean();
  if (rows.length === 0) return 0;
  rows = [...rows].sort((a, b) => {
    const pa = opts.preferLocationId && a.locationId === opts.preferLocationId ? 1 : 0;
    const pb = opts.preferLocationId && b.locationId === opts.preferLocationId ? 1 : 0;
    return pb - pa || (b.stock || 0) - (a.stock || 0);
  });
  let remaining = qty;
  for (const row of rows) {
    if (remaining <= 0) break;
    for (let attempt = 0; attempt < 3 && remaining > 0; attempt++) {
      const fresh: any = attempt === 0 ? row : await r.variantLocationStockModel.findOne({ _id: row._id }).session(session ?? null).lean();
      const take = Math.min(remaining, Math.max(0, fresh?.stock || 0));
      if (take <= 0) break;
      const res = await r.variantLocationStockModel.updateOne({ _id: row._id, stock: { $gte: take } }, { $inc: { stock: -take } }, { session });
      if (res.modifiedCount > 0) { remaining -= take; break; }
    }
  }
  return qty - remaining;
}

/** Puts `qty` units back: `preferLocationId` row if the variant has one there, else the default location's row, else the first row. */
export async function restoreLocationStock(
  r: Repos,
  variantId: string,
  qty: number,
  opts: { preferLocationId?: string | null; session?: ClientSession } = {},
): Promise<boolean> {
  if (!(qty > 0)) return false;
  const { session } = opts;
  const rows: any[] = await r.variantLocationStockModel.find({ variantId }).session(session ?? null).lean();
  if (rows.length === 0) return false;
  let target = opts.preferLocationId ? rows.find((x) => x.locationId === opts.preferLocationId) : undefined;
  if (!target && r.storeLocationModel) {
    const def: any = await r.storeLocationModel.findOne({ _id: { $in: rows.map((x) => x.locationId) }, isDefault: true, isDelete: false }).session(session ?? null).lean();
    if (def) target = rows.find((x) => x.locationId === String(def._id));
  }
  target = target ?? rows[0];
  await r.variantLocationStockModel.updateOne({ _id: target._id }, { $inc: { stock: qty } }, { session });
  return true;
}
