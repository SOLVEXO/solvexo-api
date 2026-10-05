/* eslint-disable prettier/prettier */

/**
 * The ONE definition of "how many units can still be sold" for a variant:
 *   stock − committedStock − damagedStock − inTransitStock
 * Reserved (committed) units belong to pending orders, damaged units are not sellable, and in-transit units are not on the
 * shelf yet. Checkout, payment, draft orders, POS, order editing and the inventory screens all use this, so a product can
 * never show as "in stock" on one screen and "sold out" on another (Shopify's "Available" quantity).
 */
export function availableStock(v: { stock?: number | null; committedStock?: number | null; damagedStock?: number | null; inTransitStock?: number | null } | null | undefined): number {
  if (!v) return 0;
  return (Number(v.stock) || 0) - (Number(v.committedStock) || 0) - (Number(v.damagedStock) || 0) - (Number(v.inTransitStock) || 0);
}

/** Same formula as a MongoDB aggregation expression, for atomic `$expr` reservation guards. */
export const AVAILABLE_STOCK_EXPR = {
  $subtract: [
    { $subtract: [{ $subtract: ['$stock', { $ifNull: ['$committedStock', 0] }] }, { $ifNull: ['$damagedStock', 0] }] },
    { $ifNull: ['$inTransitStock', 0] },
  ],
};
