/* eslint-disable prettier/prettier */
/**
 * G2.5 — invoice / credit-note arithmetic, ALL in integer minor units (so JPY exponent 0, USD/PKR 2 and KWD 3 behave identically).
 *
 * A sale's discount and tax are decided once for the whole sale (`computeTotals`); these helpers split them over the lines so every
 * line carries its own gross / discount / net / tax, and the lines add up to the sale's figures EXACTLY (largest-remainder rounding).
 * A return of `q` units of a line is then priced by CUMULATIVE proration — `share(r+q) − share(r)` where `r` units came back before —
 * so however a line is returned (in one go, one unit at a time, from two tills) the credits add up to exactly what the line was
 * charged, never a minor unit more or less.
 */

/** Integer division with half-up rounding for non-negative integers: round(a / b). */
export function divRound(a: number, b: number): number {
  if (b <= 0) return 0;
  return Math.floor((2 * a + b) / (2 * b));
}

/** Splits `total` (≥ 0, integer) over `weights` (≥ 0) proportionally; the parts always sum to `total` (largest remainder, ties → first). */
export function allocateLargestRemainder(total: number, weights: number[]): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (n === 0 || total <= 0 || sum <= 0) return out;
  const rem: Array<{ i: number; r: number }> = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const exact = total * weights[i];
    const q = Math.floor(exact / sum);
    out[i] = q;
    used += q;
    rem.push({ i, r: exact - q * sum });
  }
  rem.sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < total - used; k++) out[rem[k % n].i] += 1;
  return out;
}

export interface BreakdownInput {
  /** `lineTotalMinor` of each line (price × qty, rounded). */
  grossMinor: number;
  /** false = tax-exempt line (custom item with taxCategory 'exempt'). */
  taxable: boolean;
}
export interface LineBreakdown {
  grossMinor: number;
  /** this line's share of the sale discount (proportional to gross) */
  discountMinor: number;
  /** gross − discount: the line's value excluding tax */
  netMinor: number;
  /** this line's share of the sale tax (proportional to the taxable net) */
  taxMinor: number;
  /** net + tax: what the customer paid for the line */
  totalMinor: number;
}

/** Per-line split of the sale's discount and tax. Σ discount = discountMinor, Σ tax = taxMinor (when at least one line is taxable). */
export function lineBreakdown(lines: BreakdownInput[], discountMinor: number, taxMinor: number): LineBreakdown[] {
  const disc = allocateLargestRemainder(discountMinor, lines.map((l) => l.grossMinor));
  const nets = lines.map((l, i) => l.grossMinor - disc[i]);
  const tax = allocateLargestRemainder(taxMinor, lines.map((l, i) => (l.taxable ? nets[i] : 0)));
  return lines.map((l, i) => ({ grossMinor: l.grossMinor, discountMinor: disc[i], netMinor: nets[i], taxMinor: tax[i], totalMinor: nets[i] + tax[i] }));
}

/** The part of `totalMinor` that belongs to the first `n` of `soldQty` units (cumulative, half-up). share(soldQty) === totalMinor. */
export function cumulativeShare(totalMinor: number, soldQty: number, n: number): number {
  if (soldQty <= 0 || n <= 0) return 0;
  if (n >= soldQty) return totalMinor;
  return divRound(totalMinor * n, soldQty);
}

/** The credit for returning `qty` more units of a line of which `soldQty` were sold and `returnedQty` already came back. */
export function returnLineAmounts(line: LineBreakdown, soldQty: number, returnedQty: number, qty: number): LineBreakdown {
  const part = (v: number) => cumulativeShare(v, soldQty, returnedQty + qty) - cumulativeShare(v, soldQty, returnedQty);
  const grossMinor = part(line.grossMinor);
  const discountMinor = part(line.discountMinor);
  const taxMinor = part(line.taxMinor);
  const netMinor = grossMinor - discountMinor;
  return { grossMinor, discountMinor, netMinor, taxMinor, totalMinor: netMinor + taxMinor };
}

/** Number formatting for document numbers: INV-000123. */
export function formatDocNumber(prefix: string, seq: number, width = 6): string {
  return `${prefix}-${String(seq).padStart(width, '0')}`;
}
export const INVOICE_PREFIX = 'INV';
export const CREDIT_NOTE_PREFIX = 'CN';

/** Whole days between two instants (floor). */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** Why a return needs a manager. Empty = a cashier may do it (when the store allows cashier returns). */
export function returnApprovalReasons(opts: {
  amountMinor: number;
  aboveMinor: number | null;
  daysSinceSale: number;
  afterDays: number | null;
  receiptPresented: boolean;
  cashierReturnsEnabled: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!opts.cashierReturnsEnabled) reasons.push('store_requires_manager');
  if (opts.aboveMinor !== null && opts.amountMinor > opts.aboveMinor) reasons.push('amount_above_limit');
  if (opts.afterDays !== null && opts.daysSinceSale > opts.afterDays) reasons.push('too_many_days_since_sale');
  if (!opts.receiptPresented) reasons.push('no_original_receipt');
  return reasons;
}
