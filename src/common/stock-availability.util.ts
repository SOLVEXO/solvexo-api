/* eslint-disable prettier/prettier */

/**
 * The ONE definition of "how many units can still be sold" for a variant:
 *   stock − committedStock − damagedStock − inTransitStock − expired units
 * Reserved (committed) units belong to pending orders, damaged units are not sellable, in-transit units are not on the shelf
 * yet, and units in lots past their expiry date must not be sold. Checkout, payment, draft orders, POS, order editing and the
 * inventory screens all use this, so a product can never show as "in stock" on one screen and "sold out" on another
 * (Shopify's "Available" quantity).
 */
type ExpiryBucket = { at?: Date | string | null; units?: number | null };

/** Units that cannot be sold because their lot has expired: already-flagged units plus any upcoming bucket whose date has passed
 *  (see common/expired-stock.util.ts). */
export function expiredUnits(v: { expiredStock?: number | null; expiryBuckets?: ExpiryBucket[] | null } | null | undefined, now: Date = new Date()): number {
  if (!v) return 0;
  const lapsed = (v.expiryBuckets ?? []).reduce((s, b) => (b?.at && new Date(b.at).getTime() <= now.getTime() ? s + (Number(b.units) || 0) : s), 0);
  return (Number(v.expiredStock) || 0) + lapsed;
}

export function availableStock(v: { stock?: number | null; committedStock?: number | null; damagedStock?: number | null; inTransitStock?: number | null; expiredStock?: number | null; expiryBuckets?: ExpiryBucket[] | null } | null | undefined): number {
  if (!v) return 0;
  return (Number(v.stock) || 0) - (Number(v.committedStock) || 0) - (Number(v.damagedStock) || 0) - (Number(v.inTransitStock) || 0) - expiredUnits(v);
}

/** Expired units as a Mongo expression: the flagged count plus every upcoming bucket whose date is <= the database clock ($$NOW). */
export const EXPIRED_UNITS_EXPR = {
  $add: [
    { $ifNull: ['$expiredStock', 0] },
    {
      $sum: {
        $map: {
          input: { $filter: { input: { $ifNull: ['$expiryBuckets', []] }, as: 'b', cond: { $lte: ['$$b.at', '$$NOW'] } } },
          as: 'b',
          in: { $ifNull: ['$$b.units', 0] },
        },
      },
    },
  ],
};

/** Same formula as a MongoDB aggregation expression, for atomic `$expr` reservation guards. */
export const AVAILABLE_STOCK_EXPR = {
  $subtract: [
    {
      $subtract: [
        { $subtract: [{ $subtract: ['$stock', { $ifNull: ['$committedStock', 0] }] }, { $ifNull: ['$damagedStock', 0] }] },
        { $ifNull: ['$inTransitStock', 0] },
      ],
    },
    EXPIRED_UNITS_EXPR,
  ],
};
