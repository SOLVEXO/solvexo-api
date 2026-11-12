/* eslint-disable prettier/prettier */
import { cumulativeShare } from './pos-documents.util';

/**
 * Loyalty at the till in INTEGERS (G3.3, D2) — every amount is minor units, every point a whole number, so the result is identical for any currency exponent (0 / 2 / 3).
 *  - EARN: points = floor(netSpendMinor / earnSpendMinor), where net spend = what the customer paid for the goods: after discount, before tax. Rate null / 0 → nothing earned.
 *  - REDEEM: a point is worth `redeemMinorPerPoint` minor units; the discount = points × that — never more than the sale's subtotal after other discounts.
 *  - REVERSE on returns, PROPORTIONALLY and CUMULATIVELY (like the tax of a return): the points reversed after returning R of a sale of net N are cumulativeShare(earned, N, R); each return
 *    takes the difference to what was reversed before, so any chunking / order of returns reverses exactly `earned` in total, never one point more. Redeemed points come back the same way,
 *    in proportion to the money returned.
 */
export const earnPoints = (netSpendMinor: number, earnSpendMinor: number | null | undefined): number =>
  !earnSpendMinor || earnSpendMinor <= 0 || !(netSpendMinor > 0) ? 0 : Math.floor(netSpendMinor / earnSpendMinor);

export const redeemValueMinor = (points: number, redeemMinorPerPoint: number | null | undefined): number =>
  !redeemMinorPerPoint || redeemMinorPerPoint <= 0 || !(points > 0) ? 0 : points * redeemMinorPerPoint;

/** The points to reverse NOW, given the cumulative net returned after this return and what was reversed so far. */
export function pointsToReverse(earned: number, netSoldMinor: number, returnedNetAfterMinor: number, reversedSoFar: number): number {
  if (!(earned > 0) || !(netSoldMinor > 0)) return 0;
  return Math.max(0, cumulativeShare(earned, netSoldMinor, Math.min(returnedNetAfterMinor, netSoldMinor)) - reversedSoFar);
}

/** Redeemed points that come back for a return: proportional to the money returned of the sale's total. */
export function pointsToRestore(redeemed: number, saleTotalMinor: number, returnedTotalAfterMinor: number, restoredSoFar: number): number {
  if (!(redeemed > 0) || !(saleTotalMinor > 0)) return 0;
  return Math.max(0, cumulativeShare(redeemed, saleTotalMinor, Math.min(returnedTotalAfterMinor, saleTotalMinor)) - restoredSoFar);
}

export function tierFor(lifetimePoints: number, tiers: Array<{ name: string; minPoints: number }>): string | null {
  return tiers.filter((t) => lifetimePoints >= t.minPoints).sort((a, b) => b.minPoints - a.minPoints)[0]?.name ?? null;
}
