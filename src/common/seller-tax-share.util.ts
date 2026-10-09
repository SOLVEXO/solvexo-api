import { round } from './number.util';

/**
 * The sales-tax part of the amount handed to `FinanceService.recordSale` (`basis`, in the seller's settlement currency).
 * `so.taxAmount` is in the sub-order's own unit, while `basis` may already have been converted to the settlement
 * currency — so the tax is taken as the same SHARE of the gross, never copied across currencies.
 */
export function sellerTaxShare(so: { subtotal?: number; taxAmount?: number; platformSponsoredDiscountUSD?: number }, basis: number): number {
  const tax = so.taxAmount ?? 0;
  if (!(tax > 0) || !(basis > 0)) return 0;
  const gross = (so.subtotal ?? 0) + (so.platformSponsoredDiscountUSD ?? 0) + tax;
  return gross > 0 ? round((basis * tax) / gross) : 0;
}
