/* eslint-disable prettier/prettier */
import { Model } from 'mongoose';
import { round } from './analytics-number.util';

/**
 * Shared `Order`/`sellerOrders` aggregation building blocks, used by both the
 * seller-scoped `AnalyticsService` and the platform-wide `AdminAnalyticsService`.
 *
 * Every function takes an optional `scopeMatch` — a Mongo match object applied
 * right after `$unwind: '$sellerOrders'`. Pass `{ 'sellerOrders.storeId': storeId }`
 * to scope to one store (seller analytics), `{ 'sellerOrders.sellerId': sellerId }`
 * to scope to one seller (admin drill-down), or omit it entirely for a platform-wide
 * aggregation across every seller/store (admin dashboards).
 *
 * Cancelled `sellerOrders` are excluded from every revenue/order metric — they
 * represent no completed business activity by convention (documented in the
 * seller analytics report this module was extracted from).
 */

export function notCancelledCond() {
  return { $ne: ['$sellerOrders.status', 'cancelled'] };
}

/** Sum of item-level refunds for the current sellerOrder — `$sum` over an array field works as an array accumulator outside `$group`. */
export function itemRefundSumField() {
  return { $sum: '$sellerOrders.items.refundedAmount' };
}

/**
 * Platform/reporting-currency normalization — every amount field on an
 * `Order` and its `sellerOrders` (subtotal, item totals, refunds) is
 * denominated in that ONE order's own `currency` (never mixed within a
 * single order), so any such raw amount can be converted to USD via
 * `amount / Order.ratePerUSD` (see `Order.ratePerUSD`'s schema comment for
 * why this is safe and where that field comes from).
 *
 * Solvexo's platform/reporting currency is USD (its own Stripe/platform
 * billing is USD) — every cross-order revenue aggregation in this codebase
 * must go through `toUSD`/`sumUSD` rather than summing `sellerOrders.subtotal`
 * (or any other raw amount field) directly, or it silently blends orders
 * placed in different buyer currencies into one meaningless number.
 */

/**
 * Plain-JS mirror of the `toUSD` Mongo expression below — same rule,
 * directly unit-testable without a live MongoDB (see
 * `order-aggregation.util.spec.ts`). MUST stay in sync with `toUSD`; any
 * change to one's rule (the null/zero/negative-rate guard, or the division
 * itself) must be made to both.
 */
export function toUSDValue(amount: number, ratePerUSD: number | null | undefined): number | null {
  if (ratePerUSD == null || ratePerUSD <= 0) return null;
  return amount / ratePerUSD;
}

/** Converts a same-currency-as-order raw amount expression to USD, or
 *  `null` when this order's `ratePerUSD` is unknown — a genuine historical
 *  gap (an order placed before `ratePerUSD` existed, in a non-USD currency,
 *  with no matching `fxSnapshots` entry to derive it from). Callers must
 *  exclude (never zero-fill or guess) a `null` here from a per-row USD
 *  figure; use `sumUSD` for a `$group` accumulator, which treats it as a
 *  disclosed 0 rather than a silent one. Mirrors `toUSDValue` above — see
 *  that function's tests for the rule this expression implements. */
export function toUSD(rawAmountExpr: any) {
  return {
    $cond: [
      { $and: [{ $ne: ['$ratePerUSD', null] }, { $gt: ['$ratePerUSD', 0] }] },
      { $divide: [rawAmountExpr, '$ratePerUSD'] },
      null,
    ],
  };
}

/**
 * The currency a report is shown in. Admin analytics: USD (omit it). A store's own analytics: the store currency,
 * like Shopify's reports. Each order is converted at the rate frozen ON THAT ORDER (its `fxSnapshots` entry for the
 * store currency) — never today's rate — and an order already placed in the store currency is used as-is.
 * `fallbackRatePerUSD` (latest accepted rate) is used only for an old order whose snapshots lack that currency.
 */
export interface ReportingCurrency {
  code: string;
  fallbackRatePerUSD: number | null;
}

const isUsd = (rc?: ReportingCurrency | null) => !rc || rc.code === 'USD';

/** Converts a same-currency-as-order raw amount expression to the report currency (USD when `rc` is omitted). Null when unconvertible. */
export function toReporting(rawAmountExpr: any, rc?: ReportingCurrency | null) {
  if (isUsd(rc)) return toUSD(rawAmountExpr);
  const snapshot = {
    $arrayElemAt: [{ $filter: { input: { $ifNull: ['$fxSnapshots', []] }, as: 's', cond: { $eq: ['$$s.currency', rc!.code] } } }, 0],
  };
  return {
    $cond: [
      { $eq: ['$currency', rc!.code] },
      rawAmountExpr,
      {
        $let: {
          vars: { usd: toUSD(rawAmountExpr), rate: { $ifNull: [{ $let: { vars: { s: snapshot }, in: '$$s.ratePerUSD' } }, rc!.fallbackRatePerUSD] } },
          in: { $cond: [{ $or: [{ $eq: ['$$usd', null] }, { $eq: ['$$rate', null] }] }, null, { $multiply: ['$$usd', '$$rate'] }] },
        },
      },
    ],
  };
}

/** True when this order's amounts can't be converted to the report currency (see `toUSD`). */
export function unconvertibleCond(rc?: ReportingCurrency | null) {
  const noRate = { $or: [{ $eq: ['$ratePerUSD', null] }, { $lte: ['$ratePerUSD', 0] }] };
  return isUsd(rc) ? noRate : { $and: [{ $ne: ['$currency', rc!.code] }, noRate] };
}

/** `$sum`-ready total in the report currency (USD by default) — an unconvertible row (see `toUSD`) contributes 0
 *  rather than being guessed at. Pair with `unconvertibleCountField()` in
 *  the same `$group` so the excluded amount is disclosed, not hidden. */
export function sumUSD(rawAmountExpr: any, rc?: ReportingCurrency | null) {
  return { $sum: { $ifNull: [toReporting(rawAmountExpr, rc), 0] } };
}

/** `$sum`-ready count of rows excluded from every `sumUSD` in the same
 *  `$group` because `ratePerUSD` is unknown on that order — surface this
 *  wherever a USD total is reported, the same way a "Not Recorded"
 *  geography label discloses a gap instead of hiding it. */
export function unconvertibleCountField(rc?: ReportingCurrency | null) {
  return { $sum: { $cond: [unconvertibleCond(rc), 1, 0] } };
}

/**
 * Pre-`$unwind` copy of a `sellerOrders.*` scope: matching an array path before the unwind keeps only orders where
 * SOME sellerOrder is in scope (a superset — the exact match still runs after the unwind), so the
 * `sellerOrders.storeId` index is used instead of scanning every order on the platform in the window.
 */
function preUnwindScope(scopeMatch?: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(scopeMatch ?? {})) {
    if (k.startsWith('sellerOrders.')) out[k] = v;
  }
  return out;
}

/**
 * Base match+unwind stage shared by every sellerOrder-level aggregation. There's no
 * top-level storeId/sellerId on `Order` — an order can span multiple sellers — so
 * scoping always happens after the unwind.
 *
 * Typed `any[]` (not `PipelineStage[]`) deliberately — these stages get spread into
 * hand-built aggregation arrays alongside further literal stages at each call site,
 * and Mongoose's `PipelineStage` discriminated union can't structurally verify a
 * dynamically-assembled pipeline. `any[]` matches this codebase's existing convention
 * of passing plain object literals straight to `.aggregate()` with no stage typing.
 */
export function sellerOrderMatchStage(from: Date, to: Date, scopeMatch?: Record<string, any>): any[] {
  const stages: any[] = [
    { $match: { isDelete: false, createdAt: { $gte: from, $lte: to }, ...preUnwindScope(scopeMatch) } },
    { $unwind: '$sellerOrders' },
  ];
  if (scopeMatch) stages.push({ $match: scopeMatch });
  return stages;
}

export interface PeriodTotals {
  orderCount: number;
  cancelledCount: number;
  refundedCount: number;
  grossRevenue: number;
  refundAmount: number;
  netRevenue: number;
  avgOrderValue: number;
  uniqueBuyerCount: number;
  buyerIds: string[];
  /** Non-cancelled orders in this window whose `ratePerUSD` is unknown
   *  (see `toUSD`) and were therefore excluded from `grossRevenue`/
   *  `refundAmount`/`netRevenue` — disclose this alongside the totals
   *  rather than letting a silent 0-contribution look like a complete sum. */
  unconvertibleOrderCount: number;
}

export async function periodTotals(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>, rc?: ReportingCurrency | null): Promise<PeriodTotals> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $addFields: { itemRefund: itemRefundSumField() } },
    {
      $group: {
        _id: null,
        orderCount: { $sum: { $cond: [notCancelledCond(), 1, 0] } },
        cancelledCount: { $sum: { $cond: [notCancelledCond(), 0, 1] } },
        refundedCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'refunded'] }, 1, 0] } },
        grossRevenue: { $sum: { $cond: [notCancelledCond(), { $ifNull: [toReporting('$sellerOrders.subtotal', rc), 0] }, 0] } },
        refundAmount: { $sum: { $cond: [notCancelledCond(), { $ifNull: [toReporting('$itemRefund', rc), 0] }, 0] } },
        unconvertibleOrderCount: { $sum: { $cond: [{ $and: [notCancelledCond(), unconvertibleCond(rc)] }, 1, 0] } },
        buyerIds: { $addToSet: { $cond: [notCancelledCond(), { $ifNull: ['$customerId', '$userId'] }, '$$REMOVE'] } },
      },
    },
  ]);

  const row = rows[0] ?? {
    orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, unconvertibleOrderCount: 0, buyerIds: [],
  };
  const netRevenue = round(row.grossRevenue - row.refundAmount);
  return {
    orderCount: row.orderCount,
    cancelledCount: row.cancelledCount,
    refundedCount: row.refundedCount,
    grossRevenue: round(row.grossRevenue),
    refundAmount: round(row.refundAmount),
    netRevenue,
    avgOrderValue: row.orderCount > 0 ? round(netRevenue / row.orderCount) : 0,
    uniqueBuyerCount: (row.buyerIds ?? []).length,
    buyerIds: (row.buyerIds ?? []) as string[],
    unconvertibleOrderCount: row.unconvertibleOrderCount ?? 0,
  };
}

export async function repeatBuyerPercent(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>): Promise<number> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
    { $group: { _id: { $ifNull: ['$customerId', '$userId'] }, orders: { $sum: 1 } } },
    {
      $group: {
        _id: null,
        totalCustomers: { $sum: 1 },
        repeatCustomers: { $sum: { $cond: [{ $gte: ['$orders', 2] }, 1, 0] } },
      },
    },
  ]);
  const row = rows[0];
  if (!row || row.totalCustomers === 0) return 0;
  return round((row.repeatCustomers / row.totalCustomers) * 100);
}

/** Buyers among `buyerIds` who already had a non-cancelled order (within `scopeMatch`'s scope) before `from`. */
export async function returningBuyerSet(orderModel: Model<any>, buyerIds: string[], from: Date, scopeMatch?: Record<string, any>): Promise<Set<string>> {
  if (buyerIds.length === 0) return new Set();
  const rows = await orderModel.aggregate([
    { $match: { isDelete: false, $or: [{ userId: { $in: buyerIds } }, { customerId: { $in: buyerIds } }], createdAt: { $lt: from }, ...preUnwindScope(scopeMatch) } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    { $group: { _id: { $ifNull: ['$customerId', '$userId'] } } },
  ]);
  return new Set(rows.map((r: any) => r._id));
}

export interface ProductSaleAggregate {
  productId: string;
  name: string;
  orderCount: number;
  unitsSold: number;
  grossRevenue: number;
  refundedAmount: number;
  netRevenue: number;
}

/** Shared item-level sales aggregation reused by top-products/product-performance on both the seller and admin sides. */
export async function aggregateProductSales(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>, rc?: ReportingCurrency | null): Promise<ProductSaleAggregate[]> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
    { $unwind: '$sellerOrders.items' },
    {
      $group: {
        _id: '$sellerOrders.items.productId',
        name: { $first: '$sellerOrders.items.name' },
        orderCount: { $sum: 1 },
        unitsSold: { $sum: '$sellerOrders.items.quantity' },
        grossRevenue: sumUSD('$sellerOrders.items.totalPrice', rc),
        refundedAmount: sumUSD('$sellerOrders.items.refundedAmount', rc),
      },
    },
  ]);

  return rows.map((r: any) => ({
    productId: r._id,
    name: r.name,
    orderCount: r.orderCount,
    unitsSold: r.unitsSold,
    grossRevenue: round(r.grossRevenue),
    refundedAmount: round(r.refundedAmount),
    netRevenue: round(r.grossRevenue - r.refundedAmount),
  }));
}

export interface AllTimeCustomerAggregate {
  userId: string;
  firstOrderAt: Date;
  lastOrderAt: Date;
  totalOrders: number;
  lifetimeValue: number;
}

/** All-time per-customer aggregate (within `scopeMatch`'s scope) — the base for LTV, and for classifying new vs returning within any period. */
export async function allTimeCustomerAggregate(orderModel: Model<any>, scopeMatch?: Record<string, any>, rc?: ReportingCurrency | null): Promise<AllTimeCustomerAggregate[]> {
  const rows = await orderModel.aggregate([
    { $match: { isDelete: false, ...preUnwindScope(scopeMatch) } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    { $addFields: { itemRefund: itemRefundSumField() } },
    {
      $group: {
        _id: { $ifNull: ['$customerId', '$userId'] },
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        totalOrders: { $sum: 1 },
        grossRevenue: sumUSD('$sellerOrders.subtotal', rc),
        refundAmount: sumUSD('$itemRefund', rc),
      },
    },
  ]);
  return rows.map((r: any) => ({
    userId: r._id,
    firstOrderAt: r.firstOrderAt as Date,
    lastOrderAt: r.lastOrderAt as Date,
    totalOrders: r.totalOrders,
    lifetimeValue: round(r.grossRevenue - r.refundAmount),
  }));
}

export interface AllTimeSellerActivity {
  sellerId: string;
  firstOrderAt: Date;
  lastOrderAt: Date;
  totalOrders: number;
}

/**
 * Phase 3 — all-time (never date-range-scoped) per-seller order-recency
 * aggregate — the ONLY real signal `deriveSellerSalesStatus` uses. Deliberately
 * NOT scoped to whatever `from`/`to` window a Sellers-tab caller happens to
 * have selected: a seller's status is about their real current state, not an
 * artifact of the admin's current date filter.
 */
export async function allTimeSellerActivity(orderModel: Model<any>, scopeMatch?: Record<string, any>): Promise<AllTimeSellerActivity[]> {
  const rows = await orderModel.aggregate([
    { $match: { isDelete: false, ...preUnwindScope(scopeMatch) } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    {
      $group: {
        _id: '$sellerOrders.sellerId',
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        totalOrders: { $sum: 1 },
      },
    },
  ]);
  return rows.map((r: any) => ({
    sellerId: r._id,
    firstOrderAt: r.firstOrderAt as Date,
    lastOrderAt: r.lastOrderAt as Date,
    totalOrders: r.totalOrders,
  }));
}

export type SellerSalesStatus = 'new' | 'active' | 'at_risk' | 'dormant';

/**
 * Deterministic, documented seller sales-status classification — the ONLY
 * inputs are real dates (`Seller.createdAt`, and the seller's own real
 * last-non-cancelled-order date from `allTimeSellerActivity`) and `now`.
 * No randomness, no AI judgment, no per-seller special-casing. Rules, in
 * priority order:
 *
 *   1. 'new'     — registered within the last 30 days AND has never placed
 *                  a (non-cancelled) order yet. A brand-new seller hasn't
 *                  had a fair chance to sell yet, so "dormant" would be
 *                  misleading.
 *   2. 'active'  — last real order was within the last 30 days.
 *   3. 'at_risk' — last real order was 31–90 days ago (previously selling,
 *                  gone quiet recently).
 *   4. 'dormant' — last real order (if any) was more than 90 days ago, OR
 *                  the seller has never sold anything AND is older than 30
 *                  days (an established account with zero sales).
 *
 * The 30/90-day cutoffs are a disclosed policy choice (documented here,
 * surfaced to the UI via the tab's own copy), not a data-derived or
 * arbitrary/hidden threshold.
 */
export function deriveSellerSalesStatus(
  sellerCreatedAt: Date,
  lastOrderAt: Date | null,
  now: Date = new Date(),
): SellerSalesStatus {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysSinceRegistration = (now.getTime() - sellerCreatedAt.getTime()) / DAY_MS;

  if (!lastOrderAt) {
    return daysSinceRegistration <= 30 ? 'new' : 'dormant';
  }

  const daysSinceLastOrder = (now.getTime() - lastOrderAt.getTime()) / DAY_MS;
  if (daysSinceLastOrder <= 30) return 'active';
  if (daysSinceLastOrder <= 90) return 'at_risk';
  return 'dormant';
}
