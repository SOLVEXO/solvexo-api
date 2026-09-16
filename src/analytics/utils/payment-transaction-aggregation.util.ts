/* eslint-disable prettier/prettier */
/**
 * Phase 8 — Payments tab real-schema audit.
 *
 * `PaymentTransaction.amount` is denominated in that transaction's OWN
 * `currency` (see the schema's own doc comment) and — unlike `Order`, which
 * gets a precomputed `ratePerUSD` at creation time (see
 * `order-aggregation.util.ts`'s module doc comment) — `PaymentTransaction`
 * has no equivalent top-level field. It DOES carry the same raw
 * `fxSnapshots` array Order derives its own rate from (copied verbatim from
 * the parent Checkout/Order at charge time — see the schema comment on
 * `fxSnapshots`), so the rate is derivable here too; this was previously a
 * disclosed-but-unfixed gap (`getPaymentBreakdown`'s admittedly-not-USD-
 * normalized `successfulPayments`/`failedPayments`/`pendingPayments`
 * totals). This module fixes that WITHOUT touching payment creation/webhook
 * code — it is a read-only analytics-side derivation from data that was
 * already being written.
 */

export interface FxSnapshotLike {
  currency: string;
  ratePerUSD: number;
}

/** Pure-JS mirror of `ratePerUSDFromSnapshotsExpr` — finds this
 *  transaction's OWN currency's rate within its OWN immutable fxSnapshots
 *  (never today's ExchangeRate table — a refund/replay must use the rate
 *  captured at charge time, same rule Order.ratePerUSD follows). Returns
 *  `null` (never a guess, never 0) when no matching, valid snapshot exists —
 *  a real gap: historical PaymentTransaction rows predating fxSnapshots, or
 *  a transaction whose currency was never recorded. */
export function deriveRatePerUSD(fxSnapshots: FxSnapshotLike[] | undefined, currency: string | undefined): number | null {
  if (!currency || !fxSnapshots?.length) return null;
  const match = fxSnapshots.find((s) => s.currency === currency);
  if (!match || !(match.ratePerUSD > 0)) return null;
  return match.ratePerUSD;
}

/** Mongo expression mirror of `deriveRatePerUSD`, for a `$addFields`/`$project` stage. */
export function ratePerUSDFromSnapshotsExpr() {
  return {
    $let: {
      vars: {
        match: {
          $first: {
            $filter: {
              input: { $ifNull: ['$fxSnapshots', []] },
              as: 'fx',
              cond: { $eq: ['$$fx.currency', '$currency'] },
            },
          },
        },
      },
      in: {
        $cond: [
          { $and: [{ $ne: ['$$match', null] }, { $gt: ['$$match.ratePerUSD', 0] }] },
          '$$match.ratePerUSD',
          null,
        ],
      },
    },
  };
}

/** USD-normalized `$amount` (divided by the derived rate), or `null` — never
 *  a guess, never a silent 0 — when unconvertible. Intended for an
 *  `$addFields` stage so the same derived value can both feed a `$sum` and
 *  be checked for null (the unconvertible count) without re-deriving twice. */
export function amountUSDExpr() {
  return {
    $let: {
      vars: { rate: ratePerUSDFromSnapshotsExpr() },
      in: { $cond: [{ $ne: ['$$rate', null] }, { $divide: ['$amount', '$$rate'] }, null] },
    },
  };
}
