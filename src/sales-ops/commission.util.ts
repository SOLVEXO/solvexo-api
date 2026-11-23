/* eslint-disable prettier/prettier */

/**
 * Partner commissions: pure money rules, unit-tested. The service feeds them Solvexo's own plan invoices
 * (PlatformPlanInvoice) for each referred merchant.
 *
 * A plan can pay:
 *  - a one-time bounty (PKR) when a referred merchant makes their first plan payment, and/or
 *  - a percentage of what the merchant pays Solvexo (excluding Solvexo's tax, less refunds), for the first N months
 *    after their first payment, or for as long as they pay (N = null).
 * Volume tiers can raise the percentage once a partner has enough paying merchants.
 * Every amount is held for `holdDays` (the refund window) before it can be paid out.
 */

const DAY = 86_400_000;
export const roundPKR = (n: number) => Math.round(n);

export interface PlanRules {
  bountyPKR: number | null;
  percent: number | null;
  /** Months after the merchant's first payment that the percentage applies; null = for as long as they pay. */
  percentMonths: number | null;
  /** Higher percentage from a number of paying merchants upward, e.g. [{ minPaying: 10, percent: 25 }]. */
  tiers: { minPaying: number; percent: number }[];
  holdDays: number;
  /**
   * Programme B4.1: card processing fees are not part of the commission base. Applied only to card payments made on or
   * after `from` (when the rate was set), so commission already earned is never reduced (B4.10).
   */
  cardFee?: { percent: number; fixedUSD: number; from: Date } | null;
}

export interface InvoiceRow {
  id: string;
  sellerId: string;
  storeId: string;
  invoiceNumber: string;
  amountUSD: number;
  subtotalUSD: number | null;
  taxAmountUSD: number;
  refundedAmountUSD: number;
  status: string;
  paidAt: Date;
  paymentMethodType?: string | null;
}

/** What Solvexo kept from an invoice: before tax, after refunds. Never below zero. */
export function netUSD(
  inv: Pick<
    InvoiceRow,
    | 'amountUSD'
    | 'subtotalUSD'
    | 'taxAmountUSD'
    | 'refundedAmountUSD'
    | 'status'
  >,
): number {
  if (inv.status === 'refunded') return 0;
  const gross = inv.amountUSD > 0 ? inv.amountUSD : 0;
  const preTax =
    inv.subtotalUSD ?? Math.max(0, gross - (inv.taxAmountUSD ?? 0));
  const keptShare =
    gross > 0 ? Math.max(0, 1 - (inv.refundedAmountUSD ?? 0) / gross) : 0;
  return Math.round(preTax * keptShare * 100) / 100;
}

/** The commission base of one invoice: what Solvexo kept (before tax, after refunds) less the card fee where it applies. */
export function commissionBaseUSD(
  inv: Pick<InvoiceRow, 'amountUSD' | 'subtotalUSD' | 'taxAmountUSD' | 'refundedAmountUSD' | 'status' | 'paidAt' | 'paymentMethodType'>,
  fee: PlanRules['cardFee'],
): number {
  const net = netUSD(inv);
  if (!fee || net <= 0 || (inv.paymentMethodType && inv.paymentMethodType !== 'card')) return net;
  if (new Date(inv.paidAt).getTime() < new Date(fee.from).getTime()) return net;
  const gross = inv.amountUSD > 0 ? inv.amountUSD : 0;
  const cost = gross * (fee.percent / 100) + fee.fixedUSD;
  return Math.max(0, Math.round((net - cost) * 100) / 100);
}

/** The percentage a partner earns given how many of their merchants pay right now. */
export function percentFor(plan: PlanRules, payingNow: number): number {
  let p = plan.percent ?? 0;
  for (const t of [...plan.tiers].sort((a, b) => a.minPaying - b.minPaying))
    if (payingNow >= t.minPaying) p = Math.max(p, t.percent);
  return p;
}

/** Does the percentage still apply to a payment made at `paidAt`, given the merchant first paid at `firstPaidAt`? */
export function percentApplies(
  plan: PlanRules,
  firstPaidAt: Date,
  paidAt: Date,
): boolean {
  if (!(percentFor(plan, Number.MAX_SAFE_INTEGER) > 0)) return false;
  if (plan.percentMonths === null || plan.percentMonths === undefined)
    return true;
  const end = new Date(firstPaidAt);
  end.setUTCMonth(end.getUTCMonth() + plan.percentMonths);
  return paidAt.getTime() < end.getTime();
}

export const payableAt = (earnedAt: Date, holdDays: number) =>
  new Date(earnedAt.getTime() + Math.max(0, holdDays) * DAY);

export type LedgerType = 'bounty' | 'percent' | 'adjustment' | 'activation';
export interface LedgerRow {
  key: string;
  type: LedgerType;
  invoiceId: string | null;
  amountPKR: number;
}
export interface PlannedRow {
  key: string;
  type: LedgerType;
  invoiceId: string;
  sellerId: string;
  storeId: string;
  basisUSD: number;
  pkrPerUSD: number;
  percent: number | null;
  amountPKR: number;
  earnedAt: Date;
  description: string;
}

/**
 * New ledger rows for one referred merchant: a bounty on the first payment, a percentage of each payment, and an
 * adjustment wherever a refund changed what an invoice earned. `existing` is what was already written (rows are
 * never edited: a change is a new adjustment row), so running this again writes nothing new.
 * `rateFor(invoice)` gives the PKR rate; an invoice that already has rows keeps the rate it was first paid out at.
 */
export function plannedRows(args: {
  plan: PlanRules;
  invoices: InvoiceRow[];
  existing: LedgerRow[];
  effectiveFrom: Date;
  payingNow: number;
  rateFor: (inv: InvoiceRow) => number;
  existingRate: (
    invoiceId: string,
  ) => { pkrPerUSD: number; percent: number | null } | null;
  /** B4.4: after 60 days' written notice that the partner stopped supporting this seller, payments earn nothing more. */
  commissionEndsAt?: Date | null;
  /**
   * A3 #8 activation bonus: once per seller that has paid for 2 full months and still pays, when the programme sets an
   * amount. `sellerPayingNow` is this seller's state today.
   */
  activation?: { amountPKR: number; sellerPayingNow: boolean; now: Date } | null;
}): PlannedRow[] {
  const { plan, existing, effectiveFrom } = args;
  const paid = args.invoices
    .filter(
      (i) =>
        ['paid', 'partially_refunded', 'refunded'].includes(i.status) &&
        i.paidAt &&
        i.amountUSD > 0,
    )
    .sort((a, b) => +new Date(a.paidAt) - +new Date(b.paidAt));
  if (!paid.length) return [];
  const first = paid[0];
  const keys = new Set(existing.map((r) => r.key));
  const out: PlannedRow[] = [];

  // Bounty: once, on the merchant's first payment, if that payment came after the referral began.
  if ((plan.bountyPKR ?? 0) > 0 && new Date(first.paidAt) >= effectiveFrom) {
    const key = `bounty:${first.sellerId}`;
    const kept = netUSD(first) > 0;
    if (!keys.has(key) && kept) {
      out.push({
        key,
        type: 'bounty',
        invoiceId: first.id,
        sellerId: first.sellerId,
        storeId: first.storeId,
        basisUSD: netUSD(first),
        pkrPerUSD: args.rateFor(first),
        percent: null,
        amountPKR: roundPKR(plan.bountyPKR!),
        earnedAt: new Date(first.paidAt),
        description: `New paying customer (invoice ${first.invoiceNumber})`,
      });
    } else if (keys.has(key) && !kept) {
      // The first payment was fully refunded: take the bounty back.
      const bountyNow = existing
        .filter((r) => r.key === key || r.key.startsWith(`${key}:adj`))
        .reduce((s, r) => s + r.amountPKR, 0);
      if (bountyNow !== 0)
        out.push({
          key: `${key}:adj:${existing.filter((r) => r.key.startsWith(`${key}:adj`)).length + 1}`,
          type: 'adjustment',
          invoiceId: first.id,
          sellerId: first.sellerId,
          storeId: first.storeId,
          basisUSD: 0,
          pkrPerUSD: args.rateFor(first),
          percent: null,
          amountPKR: -bountyNow,
          earnedAt: new Date(),
          description: `Bounty reversed: invoice ${first.invoiceNumber} refunded`,
        });
    }
  }

  // Activation bonus: 2 full months after the first payment, if the seller still pays.
  if (args.activation && args.activation.amountPKR > 0 && new Date(first.paidAt) >= effectiveFrom && netUSD(first) > 0) {
    const key = `activation:${first.sellerId}`;
    const due = new Date(first.paidAt);
    due.setUTCMonth(due.getUTCMonth() + 2);
    const ended = args.commissionEndsAt && due.getTime() >= new Date(args.commissionEndsAt).getTime();
    if (!keys.has(key) && !ended && args.activation.sellerPayingNow && args.activation.now.getTime() >= due.getTime()) {
      out.push({
        key, type: 'activation', invoiceId: first.id, sellerId: first.sellerId, storeId: first.storeId, basisUSD: 0,
        pkrPerUSD: args.rateFor(first), percent: null, amountPKR: roundPKR(args.activation.amountPKR), earnedAt: due,
        description: 'Activation bonus: seller paid for 2 full months',
      });
    }
  }

  // Percentage of each payment.
  for (const inv of paid) {
    const paidAt = new Date(inv.paidAt);
    if (
      paidAt < effectiveFrom ||
      !percentApplies(plan, new Date(first.paidAt), paidAt) ||
      (args.commissionEndsAt && paidAt.getTime() >= new Date(args.commissionEndsAt).getTime())
    )
      continue;
    const key = `pct:${inv.id}`;
    const prev = args.existingRate(inv.id);
    const pct = prev?.percent ?? percentFor(plan, args.payingNow);
    const rate = prev?.pkrPerUSD ?? args.rateFor(inv);
    if (!(pct > 0)) continue;
    const base = commissionBaseUSD(inv, plan.cardFee);
    const shouldBe = roundPKR(base * rate * (pct / 100));
    if (!keys.has(key)) {
      if (shouldBe > 0)
        out.push({
          key,
          type: 'percent',
          invoiceId: inv.id,
          sellerId: inv.sellerId,
          storeId: inv.storeId,
          basisUSD: base,
          pkrPerUSD: rate,
          percent: pct,
          amountPKR: shouldBe,
          earnedAt: paidAt,
          description: `${pct}% of invoice ${inv.invoiceNumber}`,
        });
      continue;
    }
    const delta =
      shouldBe -
      existing
        .filter((r) => r.key === key || r.key.startsWith(`${key}:adj`))
        .reduce((s, r) => s + r.amountPKR, 0);
    if (delta !== 0)
      out.push({
        key: `${key}:adj:${existing.filter((r) => r.key.startsWith(`${key}:adj`)).length + 1}`,
        type: 'adjustment',
        invoiceId: inv.id,
        sellerId: inv.sellerId,
        storeId: inv.storeId,
        basisUSD: base,
        pkrPerUSD: rate,
        percent: pct,
        amountPKR: delta,
        earnedAt: new Date(),
        description: `Refund on invoice ${inv.invoiceNumber}`,
      });
  }
  return out;
}

export interface StatementRow {
  amountPKR: number;
  earnedAt: Date;
  status: string;
  paidAt?: Date | null;
}
/** One month's statement: what was owed going in, earned in the month, paid out in the month, owed coming out. */
export function statement(
  rows: StatementRow[],
  payouts: { amountPKR: number; paidAt: Date }[],
  from: Date,
  to: Date,
) {
  const live = rows.filter((r) => r.status !== 'void');
  const earnedBefore = live
    .filter((r) => r.earnedAt < from)
    .reduce((s, r) => s + r.amountPKR, 0);
  const paidBefore = payouts
    .filter((p) => p.paidAt < from)
    .reduce((s, p) => s + p.amountPKR, 0);
  const earned = live
    .filter((r) => r.earnedAt >= from && r.earnedAt < to)
    .reduce((s, r) => s + r.amountPKR, 0);
  const paid = payouts
    .filter((p) => p.paidAt >= from && p.paidAt < to)
    .reduce((s, p) => s + p.amountPKR, 0);
  const opening = earnedBefore - paidBefore;
  return {
    openingPKR: opening,
    earnedPKR: earned,
    paidPKR: paid,
    closingPKR: opening + earned - paid,
  };
}
