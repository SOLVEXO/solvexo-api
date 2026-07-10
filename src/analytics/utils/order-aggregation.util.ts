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
    { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
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
}

export async function periodTotals(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>): Promise<PeriodTotals> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $addFields: { itemRefund: itemRefundSumField() } },
    {
      $group: {
        _id: null,
        orderCount: { $sum: { $cond: [notCancelledCond(), 1, 0] } },
        cancelledCount: { $sum: { $cond: [notCancelledCond(), 0, 1] } },
        refundedCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'refunded'] }, 1, 0] } },
        grossRevenue: { $sum: { $cond: [notCancelledCond(), '$sellerOrders.subtotal', 0] } },
        refundAmount: { $sum: { $cond: [notCancelledCond(), '$itemRefund', 0] } },
        buyerIds: { $addToSet: { $cond: [notCancelledCond(), '$userId', '$$REMOVE'] } },
      },
    },
  ]);

  const row = rows[0] ?? {
    orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, buyerIds: [],
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
  };
}

export async function repeatBuyerPercent(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>): Promise<number> {
  const rows = await orderModel.aggregate([
    ...sellerOrderMatchStage(from, to, scopeMatch),
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
    { $group: { _id: '$userId', orders: { $sum: 1 } } },
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
    { $match: { isDelete: false, userId: { $in: buyerIds }, createdAt: { $lt: from } } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    { $group: { _id: '$userId' } },
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
export async function aggregateProductSales(orderModel: Model<any>, from: Date, to: Date, scopeMatch?: Record<string, any>): Promise<ProductSaleAggregate[]> {
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
        grossRevenue: { $sum: '$sellerOrders.items.totalPrice' },
        refundedAmount: { $sum: '$sellerOrders.items.refundedAmount' },
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
export async function allTimeCustomerAggregate(orderModel: Model<any>, scopeMatch?: Record<string, any>): Promise<AllTimeCustomerAggregate[]> {
  const rows = await orderModel.aggregate([
    { $match: { isDelete: false } },
    { $unwind: '$sellerOrders' },
    { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, ...scopeMatch } },
    { $addFields: { itemRefund: itemRefundSumField() } },
    {
      $group: {
        _id: '$userId',
        firstOrderAt: { $min: '$createdAt' },
        lastOrderAt: { $max: '$createdAt' },
        totalOrders: { $sum: 1 },
        grossRevenue: { $sum: '$sellerOrders.subtotal' },
        refundAmount: { $sum: '$itemRefund' },
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
