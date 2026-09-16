/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from '../../common/number.util';

/**
 * Phase 6 — consumes the Phase 5 tracking foundation (`ProductView`,
 * `src/product-views/schemas/product-view.schema.ts`) to attach real
 * view/conversion figures to the Products tab.
 *
 * IMPORTANT: `ProductView` only has rows from the feature's launch date
 * forward — there is no historical backfill. A product with real, large
 * pre-launch traffic legitimately shows 0 (or a low) view count here; that
 * is a genuine coverage gap, not the product being unpopular, and nothing
 * downstream should present it otherwise (see `viewToPurchaseConversionPercent`,
 * which returns `null` rather than a misleading 0%/∞% when there is no real
 * view data to divide by).
 */

/** Real product-detail-page view counts within [from, to], optionally scoped
 *  to one store/seller drill-down. Keyed by productId (never storeId/sellerId
 *  from the caller — those only filter which stored rows are summed; every
 *  stored row's own storeId/sellerId was already resolved server-side at
 *  write time, see ProductViewsService.recordView). */
export async function aggregateProductViews(
  productViewModel: Model<any>,
  from: Date,
  to: Date,
  filter: { storeId?: string; sellerId?: string } = {},
): Promise<Map<string, number>> {
  const match: Record<string, any> = { viewedAt: { $gte: from, $lte: to } };
  if (filter.storeId) match.storeId = filter.storeId;
  if (filter.sellerId) match.sellerId = filter.sellerId;

  const rows = await productViewModel.aggregate([
    { $match: match },
    { $group: { _id: '$productId', views: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r: any) => [String(r._id), r.views as number]));
}

/** orderCount / views as a percent, rounded to 2 decimals. Returns `null`
 *  (never 0, never a fabricated number) when there are no tracked views to
 *  divide by — see the module doc comment on why that case is real, not an
 *  error. Views can be a normal fraction of orders too (multiple orders per
 *  view are possible for a repeat buyer), so a result over 100% is legitimate
 *  and is not clamped. */
export function viewToPurchaseConversionPercent(orderCount: number, views: number): number | null {
  if (!views || views <= 0) return null;
  return round((orderCount / views) * 100);
}
