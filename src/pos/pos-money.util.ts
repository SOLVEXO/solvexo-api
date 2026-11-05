/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { fromMinor, isoExponent, roundMoney, toMinor } from '@/common/money-minor.util';

/**
 * POS money rules (Phase 5B, decision D1).
 *
 * Money stays a JS number in major units in storage (the commerce backend is shared with the storefront, so
 * order/storefront money storage is untouched) — but EVERY step here is done in integer MINOR units of the
 * sale's own currency (its ISO-4217 exponent: JPY 0, USD/PKR 2, KWD 3) and rounded half-away-from-zero at
 * each step, so there is no floating-point drift and no hidden "2 decimals" assumption anywhere. The server
 * is authoritative: it computes subtotal, discount, tax and total from the line items + settings and never
 * trusts client-sent totals.
 */

export type Tender = 'cash' | 'card' | 'other' | 'raast_qr';
export const TENDERS: Tender[] = ['cash', 'card', 'other', 'raast_qr'];

/** Tenders whose money arrives through a payment provider and must be CONFIRMED before the sale exists (never cash in the drawer). */
export const DIGITAL_TENDERS: Tender[] = ['raast_qr'];
export const isDigitalTender = (m: string): boolean => (DIGITAL_TENDERS as string[]).includes(m);

/** Rejection with a machine-readable `code` (the app switches on it). */
export function moneyError(code: string, message: string, extra: object = {}): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message, ...extra });
}

export const exponentOf = (currency: string | null | undefined): number => isoExponent(currency); // ISO 4217, never the storefront display decimals

// The conversion itself lives in common/money-minor.util.ts (G1b: moved unchanged; re-exported so every import keeps working).
export { roundMoney, toMinor, fromMinor } from '@/common/money-minor.util';

/** Half-away-from-zero rounding of an already-minor-unit fractional value (e.g. 12.5 → 13). */
const roundHalfUp = (x: number): number => Math.sign(x) * Math.round(Number(Math.abs(x).toPrecision(15)));

// ── Totals ────────────────────────────────────────────────────────────────────────────────────────

export type DiscountType = 'amount' | 'percent';

export interface Totals {
  exp: number;
  lineTotals: number[];
  /** G1b: the same line totals in integer minor units (`toMinor(price × qty)` — authoritative, see G1B_PLAN §6). */
  lineTotalsMinor: number[];
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  /** The same figures in integer minor units (what the maths was actually done in). */
  minor: { subtotal: number; discount: number; tax: number; total: number };
}

/**
 * subtotal = Σ round(price × qty); discount = flat amount or % of subtotal (rounded), must not exceed the
 * subtotal (rejected, never silently clamped); tax = round((subtotal − discount) × taxRate); total = taxable + tax.
 * Tax-exclusive pricing, same base the cashier sees on the receipt.
 */
export function computeTotals(
  lines: Array<{ price: number; qty: number }>,
  opts: { exp: number; discountType?: DiscountType; discountValue?: number; taxRate: number },
): Totals {
  const { exp } = opts;
  const lineM = lines.map((l) => toMinor(l.price * l.qty, exp));
  const subtotalM = lineM.reduce((s, x) => s + x, 0);

  const dv = Number(opts.discountValue ?? 0);
  if (!(dv >= 0) || !Number.isFinite(dv)) throw moneyError('INVALID_DISCOUNT', 'Discount must be zero or more');
  let discountM = 0;
  if (dv > 0) {
    if ((opts.discountType ?? 'amount') === 'percent') {
      if (dv > 100) throw moneyError('INVALID_DISCOUNT', 'A percentage discount cannot exceed 100%');
      discountM = roundHalfUp((subtotalM * dv) / 100);
    } else {
      discountM = toMinor(dv, exp);
    }
  }
  if (discountM > subtotalM) {
    throw moneyError('DISCOUNT_EXCEEDS_SUBTOTAL', 'The discount cannot be more than the sale subtotal', {
      subtotal: fromMinor(subtotalM, exp), discount: fromMinor(discountM, exp),
    });
  }

  const taxableM = subtotalM - discountM;
  const rate = Number(opts.taxRate) || 0;
  const taxM = roundHalfUp(taxableM * rate);
  const totalM = taxableM + taxM;

  return {
    exp,
    lineTotals: lineM.map((m) => fromMinor(m, exp)),
    lineTotalsMinor: lineM,
    subtotal: fromMinor(subtotalM, exp),
    discount: fromMinor(discountM, exp),
    tax: fromMinor(taxM, exp),
    total: fromMinor(totalM, exp),
    minor: { subtotal: subtotalM, discount: discountM, tax: taxM, total: totalM },
  };
}

/**
 * The client sends the total it displayed; the server's figure always wins, but a mismatch beyond ONE minor
 * unit means the client priced the cart differently (stale price, stale tax rate, tampering) — reject with the
 * server's numbers so the app can refresh instead of charging the customer a total they didn't see.
 */
export function assertClientTotal(clientTotal: number | undefined | null, totals: Totals): void {
  if (clientTotal === undefined || clientTotal === null) return;
  if (Math.abs(toMinor(clientTotal, totals.exp) - totals.minor.total) > 1) {
    throw moneyError('TOTAL_MISMATCH', 'The total on this device does not match the current prices/tax. Refresh and try again.', {
      expectedTotal: totals.total, clientTotal, subtotal: totals.subtotal, discount: totals.discount, tax: totals.tax,
    });
  }
}

// ── Split tender ──────────────────────────────────────────────────────────────────────────────────

export interface PaymentInput { method: string; amount: number; reference?: string | null; /** digital tenders: the confirmed payment (payment_intents id) this line settles */ intentId?: string | null }

/** A stored payment line. `amount` is what was APPLIED to the sale; for cash `tendered` is what was handed over. */
export interface PaymentLine { method: Tender; amount: number; tendered?: number; reference?: string | null; intentId?: string | null }

export interface SettledPayments {
  lines: PaymentLine[];
  /** Cash handed back to the customer: Σ cash tendered − cash applied. */
  change: number;
  /** The single method, or 'split' when more than one method took part. */
  method: Tender | 'split';
  /** Only with `allowShort` (an offline sale whose device charged less than the server prices it): total − paid. */
  shortBy: number;
}

const MAX_PAYMENT_LINES = 8;

/**
 * Turns what the cashier collected into stored payment lines, validated against the server's total.
 *  - non-cash (card / other) lines can never exceed what is owed (you can't get change from a card);
 *  - cash may be MORE than what's left after the non-cash lines — the overage is change, computed here;
 *  - the applied amounts always sum to the total exactly.
 * `legacy` covers the old single-payment request (`paymentMethod` + optional `amountTendered`).
 */
export function settlePayments(
  totalM: number,
  exp: number,
  input: { payments?: PaymentInput[]; paymentMethod?: string; amountTendered?: number | null; reference?: string | null },
  opts: { allowShort?: boolean } = {},
): SettledPayments {
  let raw: PaymentInput[];
  if (input.payments && input.payments.length > 0) {
    raw = input.payments;
  } else {
    const method = input.paymentMethod ?? 'cash';
    raw = [{
      method,
      amount: method === 'cash' && input.amountTendered != null ? input.amountTendered : fromMinor(totalM, exp),
      reference: input.reference ?? null,
    }];
  }
  if (raw.length > MAX_PAYMENT_LINES) throw moneyError('TOO_MANY_PAYMENTS', `A sale can have at most ${MAX_PAYMENT_LINES} payment lines`);

  const given = raw.map((p) => {
    if (!TENDERS.includes(p.method as Tender)) throw moneyError('INVALID_PAYMENT_METHOD', `Unknown payment method "${p.method}"`);
    const m = toMinor(p.amount, exp);
    if (!(m > 0) && !(totalM === 0 && m === 0)) throw moneyError('INVALID_PAYMENT_AMOUNT', 'Every payment line must be more than zero');
    return { method: p.method as Tender, amountM: m, reference: p.reference ? String(p.reference).slice(0, 120) : null, intentId: p.intentId ? String(p.intentId) : null };
  });

  const nonCashM = given.filter((g) => g.method !== 'cash').reduce((s, g) => s + g.amountM, 0);
  if (nonCashM > totalM) {
    throw moneyError('PAYMENT_EXCEEDS_TOTAL', 'Card / other payments cannot add up to more than the total — only cash can be overpaid (change)', {
      total: fromMinor(totalM, exp), nonCashPayments: fromMinor(nonCashM, exp),
    });
  }
  const cashDueM = totalM - nonCashM;
  const cashHandedM = given.filter((g) => g.method === 'cash').reduce((s, g) => s + g.amountM, 0);
  const shortM = cashHandedM < cashDueM ? cashDueM - cashHandedM : 0;
  // `allowShort` is ONLY for an offline sale that is already over (the customer paid what the device showed): the
  // shortfall is recorded and flagged for a manager instead of rejecting money that already changed hands.
  if (shortM > 0 && !opts.allowShort) {
    throw moneyError('PAYMENT_SHORT', 'The payments do not cover the total', {
      total: fromMinor(totalM, exp), paid: fromMinor(nonCashM + cashHandedM, exp), shortBy: fromMinor(cashDueM - cashHandedM, exp),
    });
  }

  let remainingCash = Math.min(cashDueM, cashHandedM);
  const lines: PaymentLine[] = [];
  for (const g of given) {
    if (g.method !== 'cash') {
      lines.push({ method: g.method, amount: fromMinor(g.amountM, exp), reference: g.reference, ...(g.intentId ? { intentId: g.intentId } : {}) });
      continue;
    }
    const applied = Math.min(g.amountM, remainingCash);
    remainingCash -= applied;
    if (applied === 0 && totalM > 0) continue; // surplus cash line: counted only towards change
    lines.push({ method: 'cash', amount: fromMinor(applied, exp), tendered: fromMinor(g.amountM, exp), reference: g.reference });
  }
  const methods = new Set(lines.map((l) => l.method));
  return {
    lines,
    change: fromMinor(Math.max(0, cashHandedM - cashDueM), exp),
    shortBy: fromMinor(shortM, exp),
    method: methods.size > 1 ? 'split' : (lines[0]?.method ?? (input.paymentMethod as Tender) ?? 'cash'),
  };
}

// ── Reading payments (old single-payment sales stay readable) ─────────────────────────────────────

/** A sale's payment lines; for sales made before split tender, one synthetic line for the whole total. */
export function effectivePayments(sale: { payments?: PaymentLine[]; paymentMethod?: string; total?: number }): PaymentLine[] {
  if (sale.payments && sale.payments.length > 0) return sale.payments;
  const m = (TENDERS as string[]).includes(sale.paymentMethod ?? '') ? (sale.paymentMethod as Tender) : 'other';
  return [{ method: m, amount: Number(sale.total) || 0 }];
}

/**
 * REFUND ORDER (documented, deterministic): a refund is returned to the sale's tender lines
 * **non-cash first (card / other, in the order they were taken), then cash last**, each line capped at the
 * amount it actually took. Reason: card/bank money can only go back to the instrument it came from and the
 * shop cannot pay it out of the drawer, so it is exhausted first; cash is what the drawer pays out last.
 * Because the order is fixed, the split of any cumulative refunded amount can be re-derived at any time —
 * which is also how sales refunded before split tender existed are still allocated correctly.
 */
export function refundOrder(lines: PaymentLine[]): PaymentLine[] {
  return [...lines.filter((l) => l.method !== 'cash'), ...lines.filter((l) => l.method === 'cash')];
}

/** How much of each (ordered) line a CUMULATIVE refund of `refundedM` minor units has consumed. */
function absorbedPerLine(ordered: PaymentLine[], refundedM: number, exp: number): number[] {
  let left = refundedM;
  return ordered.map((l) => {
    const take = Math.min(toMinor(l.amount, exp), Math.max(0, left));
    left -= take;
    return take;
  });
}

const aggregate = (ordered: PaymentLine[], perLine: number[], exp: number): Array<{ method: Tender; amount: number }> => {
  const by = new Map<Tender, number>();
  ordered.forEach((l, i) => { if (perLine[i] > 0) by.set(l.method, (by.get(l.method) ?? 0) + perLine[i]); });
  return [...by.entries()].map(([method, m]) => ({ method, amount: fromMinor(m, exp) }));
};

/** Splits a NEW refund of `amount` across tenders, given what was already refunded in total. */
export function allocateRefund(lines: PaymentLine[], alreadyRefunded: number, amount: number, exp: number): Array<{ method: Tender; amount: number }> {
  const ordered = refundOrder(lines);
  const before = absorbedPerLine(ordered, toMinor(alreadyRefunded, exp), exp);
  const after = absorbedPerLine(ordered, toMinor(alreadyRefunded, exp) + toMinor(amount, exp), exp);
  return aggregate(ordered, after.map((a, i) => a - before[i]), exp);
}

/** Net money still held per tender after refunds (what reports and the drawer should count). */
export function tenderNets(
  sale: { payments?: PaymentLine[]; paymentMethod?: string; total?: number; refundedAmount?: number; status?: string },
  exp: number,
): Record<Tender, number> {
  const lines = effectivePayments(sale);
  const refundedM = sale.status === 'voided' ? Number.MAX_SAFE_INTEGER : toMinor(sale.refundedAmount ?? 0, exp);
  const ordered = refundOrder(lines);
  const gone = absorbedPerLine(ordered, refundedM, exp);
  const net: Record<Tender, number> = { cash: 0, card: 0, other: 0, raast_qr: 0 };
  ordered.forEach((l, i) => { net[l.method] += toMinor(l.amount, exp) - gone[i]; });
  return { cash: fromMinor(net.cash, exp), card: fromMinor(net.card, exp), other: fromMinor(net.other, exp), raast_qr: fromMinor(net.raast_qr, exp) };
}

/** Per-tender amounts as a plain object (`{cash, card, other, raast_qr}`), from a list of `{method, amount}`. */
export function byTender(parts: Array<{ method: Tender; amount: number }>): Record<Tender, number> {
  const out: Record<Tender, number> = { cash: 0, card: 0, other: 0, raast_qr: 0 };
  for (const p of parts) out[p.method] += p.amount;
  return out;
}

// ── Partial-refund amount ─────────────────────────────────────────────────────────────────────────

/**
 * Value of refunding `qty` of one line: its share of what the customer actually PAID — i.e. net of the
 * sale-level discount and including its share of tax (`price × qty × total ÷ subtotal`) — rounded to the
 * currency exponent. When this refund returns the last of the goods, the exact remainder
 * (`total − alreadyRefunded`) is refunded instead, so rounding can never leave a stray minor unit behind or
 * refund more than was paid.
 */
export function partialRefundAmount(
  sale: { subtotal: number; total: number; refundedAmount?: number },
  lines: Array<{ price: number; qty: number }>,
  exp: number,
  completesSale: boolean,
): number {
  const totalM = toMinor(sale.total, exp);
  const alreadyM = toMinor(sale.refundedAmount ?? 0, exp);
  const remainingM = Math.max(0, totalM - alreadyM);
  if (completesSale) return fromMinor(remainingM, exp);
  const subtotalM = toMinor(sale.subtotal, exp);
  if (subtotalM <= 0) return 0;
  const shareM = lines.reduce((s, l) => s + roundHalfUp((toMinor(l.price * l.qty, exp) * totalM) / subtotalM), 0);
  return fromMinor(Math.min(shareM, remainingM), exp);
}

/**
 * How a cumulative refund splits across the sale's DIGITAL lines (one provider refund per payment). Same documented order as
 * `allocateRefund` (non-cash first in the order taken, cash last), so the two always agree. Returns minor units per payment.
 */
export function digitalRefundPlan(lines: PaymentLine[], alreadyRefunded: number, amount: number, exp: number): Array<{ intentId: string; amountMinor: number }> {
  const ordered = refundOrder(lines);
  const before = absorbedPerLine(ordered, toMinor(alreadyRefunded, exp), exp);
  const after = absorbedPerLine(ordered, toMinor(alreadyRefunded, exp) + toMinor(amount, exp), exp);
  const out: Array<{ intentId: string; amountMinor: number }> = [];
  ordered.forEach((l, i) => { const d = after[i] - before[i]; if (d > 0 && isDigitalTender(l.method) && l.intentId) out.push({ intentId: String(l.intentId), amountMinor: d }); });
  return out;
}
