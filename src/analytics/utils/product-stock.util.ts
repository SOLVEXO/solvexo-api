/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { availableStock } from '../../common/stock-availability.util';

export interface ProductStockSummary {
  /** Sellable units across the product's variants: stock − committed − damaged − in-transit (never below 0 per variant). */
  available: number;
  /** True when any variant sells without a stock limit — such a product is never "out of stock" and has no sell-through. */
  unlimited: boolean;
}

/** Sellable stock per product, using the platform-wide availability formula (see `common/stock-availability.util`). */
export async function sellableStockByProduct(variantModel: Model<any>, productIds: string[]): Promise<Map<string, ProductStockSummary>> {
  const map = new Map<string, ProductStockSummary>();
  if (productIds.length === 0) return map;
  const variants: any[] = await variantModel
    .find({ productId: { $in: productIds }, isDelete: false })
    .select('productId stock committedStock damagedStock inTransitStock expiredStock expiryBuckets unlimitedStock')
    .lean();
  for (const v of variants) {
    const entry = map.get(v.productId) ?? { available: 0, unlimited: false };
    entry.available += Math.max(0, availableStock(v));
    if (v.unlimitedStock) entry.unlimited = true;
    map.set(v.productId, entry);
  }
  return map;
}
