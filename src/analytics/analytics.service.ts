/* eslint-disable prettier/prettier */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import {
  BucketGranularity,
  absoluteChange,
  enumerateBuckets,
  percentChange,
  resolveDateRange,
  trendFor,
} from './utils/analytics-date.util';
import { toCsv } from './utils/csv.util';
import { PdfReportBuilder } from './utils/pdf-report.util';

const ATTRIBUTION_SOURCES = ['marketplace_search', 'direct_link', 'social_media', 'email', 'other'] as const;
const CACHE_TTL_SECONDS = 600; // 10 minutes

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private round(n: number) {
    return Math.round(n * 100) / 100;
  }

  // ─── Ownership + caching ────────────────────────────────────────────────

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    const store = await this.r.storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');
    return store;
  }

  private async cached<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    if (this.redis.isConnected) {
      const hit = await this.redis.get(cacheKey);
      if (hit) {
        try {
          return JSON.parse(hit) as T;
        } catch {
          // fall through and recompute on a corrupt cache entry
        }
      }
    }
    const result = await compute();
    if (this.redis.isConnected) {
      await this.redis.set(cacheKey, JSON.stringify(result), CACHE_TTL_SECONDS);
    }
    return result;
  }

  private key(section: string, storeId: string, query: Record<string, any>) {
    return `analytics:${storeId}:${section}:${JSON.stringify(query)}`;
  }

  // ─── Shared aggregation building blocks ────────────────────────────────
  // Every seller-scoped Order aggregation starts the same way: unwind the
  // embedded `sellerOrders` array (there's no top-level storeId on Order —
  // an order can span multiple sellers) and match this store. Cancelled
  // sellerOrders are excluded from every revenue/order metric — they
  // represent no completed business activity by convention (documented in
  // the analytics report).

  private matchStage(storeId: string, from: Date, to: Date) {
    return [
      { $match: { isDelete: false, createdAt: { $gte: from, $lte: to } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId } },
    ];
  }

  private notCancelled() {
    return { $ne: ['$sellerOrders.status', 'cancelled'] };
  }

  /** Sum of item-level refunds for the current sellerOrder — `$sum` over an array field works as an array accumulator outside `$group`. */
  private itemRefundField() {
    return { $sum: '$sellerOrders.items.refundedAmount' };
  }

  private async periodTotals(storeId: string, from: Date, to: Date) {
    const rows = await this.r.orderModel.aggregate([
      ...this.matchStage(storeId, from, to),
      { $addFields: { itemRefund: this.itemRefundField() } },
      {
        $group: {
          _id: null,
          orderCount: { $sum: { $cond: [this.notCancelled(), 1, 0] } },
          cancelledCount: { $sum: { $cond: [this.notCancelled(), 0, 1] } },
          refundedCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'refunded'] }, 1, 0] } },
          grossRevenue: { $sum: { $cond: [this.notCancelled(), '$sellerOrders.subtotal', 0] } },
          refundAmount: { $sum: { $cond: [this.notCancelled(), '$itemRefund', 0] } },
          buyerIds: { $addToSet: { $cond: [this.notCancelled(), '$userId', '$$REMOVE'] } },
        },
      },
    ]);

    const row = rows[0] ?? {
      orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, buyerIds: [],
    };
    const netRevenue = this.round(row.grossRevenue - row.refundAmount);
    return {
      orderCount: row.orderCount,
      cancelledCount: row.cancelledCount,
      refundedCount: row.refundedCount,
      grossRevenue: this.round(row.grossRevenue),
      refundAmount: this.round(row.refundAmount),
      netRevenue,
      avgOrderValue: row.orderCount > 0 ? this.round(netRevenue / row.orderCount) : 0,
      uniqueBuyerCount: (row.buyerIds ?? []).length,
      buyerIds: (row.buyerIds ?? []) as string[],
    };
  }

  private async repeatBuyerPercent(storeId: string, from: Date, to: Date): Promise<number> {
    const rows = await this.r.orderModel.aggregate([
      ...this.matchStage(storeId, from, to),
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
    return this.round((row.repeatCustomers / row.totalCustomers) * 100);
  }

  /** Buyers among `buyerIds` who already had a non-cancelled order for this store before `from`. */
  private async returningBuyerSet(storeId: string, buyerIds: string[], from: Date): Promise<Set<string>> {
    if (buyerIds.length === 0) return new Set();
    const rows = await this.r.orderModel.aggregate([
      { $match: { isDelete: false, userId: { $in: buyerIds }, createdAt: { $lt: from } } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $group: { _id: '$userId' } },
    ]);
    return new Set(rows.map((r: any) => r._id));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to, previousFrom, previousTo } = resolveDateRange(query);
    const compare = query.compareToPreviousPeriod === true || query.compareToPreviousPeriod === 'true';

    return this.cached(this.key('overview', storeId, { from, to, compare }), async () => {
      const [current, previous, repeatBuyerPct, prevRepeatBuyerPct] = await Promise.all([
        this.periodTotals(storeId, from, to),
        this.periodTotals(storeId, previousFrom, previousTo),
        this.repeatBuyerPercent(storeId, from, to),
        this.repeatBuyerPercent(storeId, previousFrom, previousTo),
      ]);

      const returningSet = await this.returningBuyerSet(storeId, current.buyerIds, from);
      const newCustomersCount = current.uniqueBuyerCount - returningSet.size;
      const returningCustomersCount = returningSet.size;

      const refundRatePercent = current.grossRevenue > 0 ? this.round((current.refundAmount / current.grossRevenue) * 100) : 0;

      const data: Record<string, any> = {
        period: { from, to },
        grossRevenue: current.grossRevenue,
        totalRevenue: current.netRevenue, // "totalRevenue" = net of refunds, per spec
        totalRevenueChangePercent: percentChange(current.netRevenue, previous.netRevenue),
        totalOrders: current.orderCount,
        totalOrdersChange: absoluteChange(current.orderCount, previous.orderCount),
        avgOrderValue: current.avgOrderValue,
        avgOrderValueChangePercent: percentChange(current.avgOrderValue, previous.avgOrderValue),
        repeatBuyerPercent: repeatBuyerPct,
        repeatBuyerTrend: trendFor(repeatBuyerPct, prevRepeatBuyerPct),
        totalRefunds: current.refundAmount,
        refundRatePercent,
        cancelledOrders: current.cancelledCount,
        newCustomersCount,
        returningCustomersCount,
      };

      if (compare) {
        data.previousPeriod = {
          period: { from: previousFrom, to: previousTo },
          grossRevenue: previous.grossRevenue,
          totalRevenue: previous.netRevenue,
          totalOrders: previous.orderCount,
          avgOrderValue: previous.avgOrderValue,
          repeatBuyerPercent: prevRepeatBuyerPct,
          totalRefunds: previous.refundAmount,
          cancelledOrders: previous.cancelledCount,
        };
      }

      return { success: true, data };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B. REVENUE OVER TIME
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueOverTime(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('revenue-over-time', storeId, { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(storeId, from, to),
        {
          $addFields: {
            itemRefund: this.itemRefundField(),
            bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } },
          },
        },
        {
          $group: {
            _id: '$bucket',
            grossRevenue: { $sum: { $cond: [this.notCancelled(), '$sellerOrders.subtotal', 0] } },
            refundAmount: { $sum: { $cond: [this.notCancelled(), '$itemRefund', 0] } },
          },
        },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        const gross = this.round(row?.grossRevenue ?? 0);
        const refund = this.round(row?.refundAmount ?? 0);
        return { date: bucket, grossRevenue: gross, netRevenue: this.round(gross - refund) };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. ORDERS OVER TIME
  // ═══════════════════════════════════════════════════════════════════════

  async getOrdersOverTime(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('orders-over-time', storeId, { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(storeId, from, to),
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        {
          $group: {
            _id: '$bucket',
            orderCount: { $sum: { $cond: [this.notCancelled(), 1, 0] } },
            cancelledOrdersCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'cancelled'] }, 1, 0] } },
            refundedOrdersCount: { $sum: { $cond: [{ $eq: ['$sellerOrders.status', 'refunded'] }, 1, 0] } },
          },
        },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        return {
          date: bucket,
          orderCount: row?.orderCount ?? 0,
          cancelledOrdersCount: row?.cancelledOrdersCount ?? 0,
          refundedOrdersCount: row?.refundedOrdersCount ?? 0,
        };
      });

      return { success: true, data: { granularity, series } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // D. TRAFFIC SOURCES
  // ═══════════════════════════════════════════════════════════════════════

  async getTrafficSources(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('traffic-sources', storeId, { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(storeId, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        {
          $group: {
            _id: { $ifNull: ['$attributionSource', 'other'] },
            count: { $sum: 1 },
            revenue: { $sum: '$sellerOrders.subtotal' },
          },
        },
      ]);

      const bysource = new Map(rows.map((r: any) => [r._id, r]));
      const totalCount = rows.reduce((sum: number, r: any) => sum + r.count, 0);

      const breakdown = ATTRIBUTION_SOURCES.map((source) => {
        const row = bysource.get(source);
        const count = row?.count ?? 0;
        return {
          source,
          count,
          revenue: this.round(row?.revenue ?? 0),
          percent: totalCount > 0 ? this.round((count / totalCount) * 100) : 0,
        };
      });

      return { success: true, data: { total: totalCount, breakdown } };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E. TOP PRODUCTS
  // ═══════════════════════════════════════════════════════════════════════

  async getTopProducts(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);
    const limit = Number(query.limit) || 10;
    const sort = query.sort === 'units_sold' ? 'units_sold' : 'revenue';

    return this.cached(this.key('top-products', storeId, { from, to, limit, sort }), async () => {
      const rows = await this.aggregateProductSales(storeId, from, to);
      rows.sort((a, b) => (sort === 'units_sold' ? b.unitsSold - a.unitsSold : b.netRevenue - a.netRevenue));

      return {
        success: true,
        data: rows.slice(0, limit).map((r) => ({
          productId: r.productId,
          name: r.name,
          orderCount: r.orderCount,
          unitsSold: r.unitsSold,
          revenue: r.netRevenue,
        })),
      };
    });
  }

  /** Shared item-level sales aggregation reused by top-products and product-performance. */
  private async aggregateProductSales(storeId: string, from: Date, to: Date) {
    const rows = await this.r.orderModel.aggregate([
      ...this.matchStage(storeId, from, to),
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
      grossRevenue: this.round(r.grossRevenue),
      refundedAmount: this.round(r.refundedAmount),
      netRevenue: this.round(r.grossRevenue - r.refundedAmount),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. CUSTOMER ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  /** All-time per-customer aggregate for this store — the base for LTV, and for classifying new vs returning within any period. */
  private async allTimeCustomerAggregate(storeId: string) {
    const rows = await this.r.orderModel.aggregate([
      { $match: { isDelete: false } },
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId, 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $addFields: { itemRefund: this.itemRefundField() } },
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
      lifetimeValue: this.round(r.grossRevenue - r.refundAmount),
    }));
  }

  async getCustomerAnalytics(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to, granularity } = resolveDateRange(query);

    return this.cached(this.key('customers', storeId, { from, to }), async () => {
      const allTime = await this.allTimeCustomerAggregate(storeId);
      const firstOrderMap = new Map(allTime.map((c) => [c.userId, c.firstOrderAt]));

      // New vs returning per bucket, using each buyer's all-time first order date for this store.
      const periodRows = await this.r.orderModel.aggregate([
        ...this.matchStage(storeId, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $addFields: { bucket: { $dateTrunc: { date: '$createdAt', unit: granularity, timezone: 'UTC' } } } },
        { $group: { _id: { bucket: '$bucket', userId: '$userId' } } },
      ]);

      const bucketTotals = new Map<number, { newCustomers: number; returningCustomers: number }>();
      for (const row of periodRows as any[]) {
        const bucketTime = row._id.bucket.getTime();
        const firstOrderAt = firstOrderMap.get(row._id.userId);
        // "New" in this bucket = their all-time first order for this store falls within it.
        const isNew = !!firstOrderAt && firstOrderAt >= row._id.bucket && firstOrderAt < this.nextBucket(row._id.bucket, granularity);
        const entry = bucketTotals.get(bucketTime) ?? { newCustomers: 0, returningCustomers: 0 };
        if (isNew) entry.newCustomers += 1; else entry.returningCustomers += 1;
        bucketTotals.set(bucketTime, entry);
      }

      const series = enumerateBuckets(from, to, granularity).map((bucket) => {
        const totals = bucketTotals.get(bucket.getTime()) ?? { newCustomers: 0, returningCustomers: 0 };
        return { date: bucket, ...totals };
      });

      // Lifetime value summary + top customers (all-time LTV for this store).
      const avgLifetimeValue = allTime.length > 0
        ? this.round(allTime.reduce((sum, c) => sum + c.lifetimeValue, 0) / allTime.length)
        : 0;

      const topByLtv = [...allTime].sort((a, b) => b.lifetimeValue - a.lifetimeValue).slice(0, 10);
      const users = await this.r.userModel
        .find({ _id: { $in: topByLtv.map((c) => c.userId) } })
        .select('name email')
        .lean();
      const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

      const topCustomers = topByLtv.map((c) => ({
        userId: c.userId,
        name: userMap.get(c.userId)?.name ?? 'Unknown',
        email: userMap.get(c.userId)?.email ?? '',
        totalOrders: c.totalOrders,
        lifetimeValue: c.lifetimeValue,
      }));

      // Geographic breakdown — physical orders only (digital orders have no shippingAddress).
      const geoRows = await this.r.orderModel.aggregate([
        ...this.matchStage(storeId, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, shippingAddress: { $ne: null } } },
        { $group: { _id: '$shippingAddress.state', orders: { $sum: 1 }, revenue: { $sum: '$sellerOrders.subtotal' } } },
        { $sort: { revenue: -1 } },
      ]);

      return {
        success: true,
        data: {
          granularity,
          newVsReturning: series,
          averageLifetimeValue: avgLifetimeValue,
          topCustomersByLtv: topCustomers,
          geographicBreakdown: geoRows.map((r: any) => ({
            state: r._id ?? 'Unknown',
            orders: r.orders,
            revenue: this.round(r.revenue),
          })),
        },
      };
    });
  }

  private nextBucket(bucket: Date, granularity: BucketGranularity): Date {
    const next = new Date(bucket);
    if (granularity === 'day') next.setUTCDate(next.getUTCDate() + 1);
    else if (granularity === 'week') next.setUTCDate(next.getUTCDate() + 7);
    else next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F2. PRODUCT PERFORMANCE (paginated, beyond top-N)
  // ═══════════════════════════════════════════════════════════════════════

  async getProductPerformance(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    return this.cached(this.key('product-performance', storeId, { from, to, page, limit }), async () => {
      const [sales, products] = await Promise.all([
        this.aggregateProductSales(storeId, from, to),
        this.r.productModel.find({ storeId, isDelete: false }).select('name').lean(),
      ]);

      const salesMap = new Map(sales.map((s) => [s.productId, s]));
      const productIds = products.map((p: any) => p._id.toString());

      const stockRows = await this.r.productVariantModel.aggregate([
        { $match: { productId: { $in: productIds }, isDelete: false } },
        { $group: { _id: '$productId', stock: { $sum: '$stock' } } },
      ]);
      const stockMap = new Map(stockRows.map((r: any) => [r._id, r.stock]));

      const merged = products.map((p: any) => {
        const id = p._id.toString();
        const sale = salesMap.get(id);
        const stock = stockMap.get(id) ?? 0;
        const unitsSold = sale?.unitsSold ?? 0;
        const revenue = sale?.netRevenue ?? 0;
        const refundedAmount = sale?.refundedAmount ?? 0;
        return {
          productId: id,
          name: p.name,
          unitsSold,
          revenue,
          refundRatePercent: sale && sale.grossRevenue > 0 ? this.round((refundedAmount / sale.grossRevenue) * 100) : 0,
          currentStock: stock,
          isLowPerformer: unitsSold === 0 && stock > 0,
        };
      });

      merged.sort((a, b) => b.revenue - a.revenue);
      const total = merged.length;
      const start = (page - 1) * limit;
      const pageItems = merged.slice(start, start + limit);

      return {
        success: true,
        data: {
          pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
          products: pageItems,
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F3. INVENTORY INSIGHTS
  // ═══════════════════════════════════════════════════════════════════════

  async getInventoryInsights(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);

    return this.cached(this.key('inventory-insights', storeId, {}), async () => {
      // Sell-through measured over the trailing 30 days — a fixed, well-understood window for a store-wide inventory snapshot (this endpoint has no range param).
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);

      const [products, sales30d] = await Promise.all([
        this.r.productModel.find({ storeId, isDelete: false, status: 'active' }).select('name').lean(),
        this.aggregateProductSales(storeId, from, to),
      ]);

      const productIds = products.map((p: any) => p._id.toString());
      const salesMap = new Map(sales30d.map((s) => [s.productId, s.unitsSold]));

      const variants = await this.r.productVariantModel
        .find({ productId: { $in: productIds }, isDelete: false })
        .select('productId stock')
        .lean();
      const stockByProduct = new Map<string, number>();
      for (const v of variants as any[]) {
        stockByProduct.set(v.productId, (stockByProduct.get(v.productId) ?? 0) + v.stock);
      }

      const outOfStock: any[] = [];
      const fastMoving: any[] = [];
      const slowMoving: any[] = [];
      const reorderSuggestions: any[] = [];

      for (const p of products as any[]) {
        const id = p._id.toString();
        const stock = stockByProduct.get(id) ?? 0;
        const unitsSold30d = salesMap.get(id) ?? 0;
        const sellThroughRate = unitsSold30d + stock > 0 ? this.round((unitsSold30d / (unitsSold30d + stock)) * 100) : 0;

        if (stock <= 0) {
          outOfStock.push({ productId: id, name: p.name, unitsSoldLast30Days: unitsSold30d });
          continue;
        }

        const entry = { productId: id, name: p.name, currentStock: stock, unitsSoldLast30Days: unitsSold30d, sellThroughRatePercent: sellThroughRate };
        if (sellThroughRate >= 50) fastMoving.push(entry);
        else if (unitsSold30d > 0) slowMoving.push(entry);

        // Simple reorder heuristic: selling faster than 2 weeks of stock remaining at the current 30-day pace.
        const weeklyRate = unitsSold30d / (30 / 7);
        if (weeklyRate > 0 && stock < weeklyRate * 2) {
          reorderSuggestions.push({ productId: id, name: p.name, currentStock: stock, estimatedWeeksRemaining: this.round(stock / weeklyRate) });
        }
      }

      fastMoving.sort((a, b) => b.sellThroughRatePercent - a.sellThroughRatePercent);
      slowMoving.sort((a, b) => a.sellThroughRatePercent - b.sellThroughRatePercent);

      return {
        success: true,
        data: {
          note: 'Sell-through and reorder suggestions are based on the trailing 30 days. Lost-sales-from-search cross-referencing is not available — this codebase has no search/view-event tracking to correlate against out-of-stock products.',
          outOfStock,
          fastMoving: fastMoving.slice(0, 20),
          slowMoving: slowMoving.slice(0, 20),
          reorderSuggestions: reorderSuggestions.slice(0, 20),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F4. PAYMENT METHOD BREAKDOWN
  // ═══════════════════════════════════════════════════════════════════════

  async getPaymentMethods(sellerId: string, storeId: string, query: any) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('payment-methods', storeId, { from, to }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(storeId, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: '$paymentType', count: { $sum: 1 }, revenue: { $sum: '$sellerOrders.subtotal' } } },
      ]);

      const labels: Record<string, string> = { cash_on_delivery: 'Cash on Delivery', stripe: 'Card (Stripe)' };
      return {
        success: true,
        data: rows.map((r: any) => ({
          paymentType: r._id,
          label: labels[r._id] ?? r._id,
          orderCount: r.count,
          revenue: this.round(r.revenue),
        })),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F5. REVENUE BREAKDOWN — orders vs subscriptions
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueBreakdown(sellerId: string, storeId: string, query: any) {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);

    return this.cached(this.key('revenue-breakdown', storeId, { from, to }), async () => {
      const orderTotals = await this.periodTotals(storeId, from, to);

      // Subscription plans are seller-scoped, not store-scoped, in this codebase's data
      // model (a seller with multiple stores would see the same recurring-revenue figure
      // on each store's analytics) — flagged explicitly rather than silently misattributed.
      const subRows = await this.r.subscriptionInvoiceModel.aggregate([
        { $match: { sellerId: store.sellerId, status: 'paid', isDelete: false, paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amountUSD' } } },
      ]);
      const recurringRevenue = this.round(subRows[0]?.total ?? 0);

      return {
        success: true,
        data: {
          oneTimeOrderRevenue: orderTotals.netRevenue,
          recurringSubscriptionRevenue: recurringRevenue,
          totalRevenue: this.round(orderTotals.netRevenue + recurringRevenue),
          note: 'Subscription revenue is scoped to the seller (not this specific store) — this codebase\'s Subscription plans are not store-attributed.',
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // G. EXPORT
  // ═══════════════════════════════════════════════════════════════════════

  async exportCsv(sellerId: string, storeId: string, query: any): Promise<string> {
    await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);
    const section = query.section ?? 'revenue';

    switch (section) {
      case 'orders': {
        const rows = await this.r.orderModel.aggregate([
          ...this.matchStage(storeId, from, to),
          { $project: { _id: 0, orderNumber: 1, createdAt: 1, status: '$sellerOrders.status', subtotal: '$sellerOrders.subtotal', paymentType: 1 } },
          { $sort: { createdAt: -1 } },
          { $limit: 5000 },
        ]);
        return toCsv(
          ['Order Number', 'Date', 'Status', 'Subtotal', 'Payment Type'],
          rows.map((r: any) => [r.orderNumber, new Date(r.createdAt).toISOString().split('T')[0], r.status, r.subtotal.toFixed(2), r.paymentType ?? '']),
        );
      }
      case 'products': {
        const rows = await this.aggregateProductSales(storeId, from, to);
        rows.sort((a, b) => b.netRevenue - a.netRevenue);
        return toCsv(
          ['Product ID', 'Name', 'Order Count', 'Units Sold', 'Gross Revenue', 'Refunded', 'Net Revenue'],
          rows.map((r) => [r.productId, r.name, r.orderCount, r.unitsSold, r.grossRevenue.toFixed(2), r.refundedAmount.toFixed(2), r.netRevenue.toFixed(2)]),
        );
      }
      case 'customers': {
        const allTime = await this.allTimeCustomerAggregate(storeId);
        const users = await this.r.userModel.find({ _id: { $in: allTime.map((c) => c.userId) } }).select('name email').lean();
        const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));
        return toCsv(
          ['Customer', 'Email', 'Total Orders', 'Lifetime Value'],
          allTime
            .sort((a, b) => b.lifetimeValue - a.lifetimeValue)
            .map((c) => [userMap.get(c.userId)?.name ?? 'Unknown', userMap.get(c.userId)?.email ?? '', c.totalOrders, c.lifetimeValue.toFixed(2)]),
        );
      }
      case 'revenue':
      default: {
        const revenueData = await this.getRevenueOverTime(sellerId, storeId, query);
        return toCsv(
          ['Date', 'Gross Revenue', 'Net Revenue'],
          revenueData.data.series.map((s: any) => [new Date(s.date).toISOString().split('T')[0], s.grossRevenue.toFixed(2), s.netRevenue.toFixed(2)]),
        );
      }
    }
  }

  async exportPdf(sellerId: string, storeId: string, query: any): Promise<Buffer> {
    const store = await this.verifyStoreOwnership(storeId, sellerId);
    const { from, to } = resolveDateRange(query);

    const [overview, revenue, traffic, topProducts] = await Promise.all([
      this.getOverview(sellerId, storeId, query),
      this.getRevenueOverTime(sellerId, storeId, query),
      this.getTrafficSources(sellerId, storeId, query),
      this.getTopProducts(sellerId, storeId, { ...query, limit: 10 }),
    ]);

    const rangeLabel = `${from.toISOString().split('T')[0]} to ${to.toISOString().split('T')[0]}`;
    const pdf = await PdfReportBuilder.create(`${store.name} — Analytics Report`, `Period: ${rangeLabel}`);

    pdf.addSectionHeading('Overview');
    pdf.addKeyValueGrid([
      { label: 'Total Revenue (net)', value: `$${overview.data.totalRevenue.toFixed(2)}` },
      { label: 'Gross Revenue', value: `$${overview.data.grossRevenue.toFixed(2)}` },
      { label: 'Total Orders', value: `${overview.data.totalOrders}` },
      { label: 'Avg Order Value', value: `$${overview.data.avgOrderValue.toFixed(2)}` },
      { label: 'Repeat Buyers', value: `${overview.data.repeatBuyerPercent}%` },
      { label: 'Refund Rate', value: `${overview.data.refundRatePercent}%` },
    ]);

    pdf.addSectionHeading('Revenue Over Time');
    if (revenue.data.series.length > 0) {
      pdf.addTable(
        ['Date', 'Gross', 'Net'],
        revenue.data.series.map((s: any) => [new Date(s.date).toISOString().split('T')[0], `$${s.grossRevenue.toFixed(2)}`, `$${s.netRevenue.toFixed(2)}`]),
      );
    } else {
      pdf.addEmptyNote('No revenue recorded in this period.');
    }

    pdf.addSectionHeading('Traffic Sources');
    pdf.addTable(
      ['Source', 'Orders', 'Revenue', '%'],
      traffic.data.breakdown.map((b: any) => [b.source, b.count, `$${b.revenue.toFixed(2)}`, `${b.percent}%`]),
    );

    pdf.addSectionHeading('Top Products by Revenue');
    if (topProducts.data.length > 0) {
      pdf.addTable(
        ['Product', 'Orders', 'Units', 'Revenue'],
        topProducts.data.map((p: any) => [p.name, p.orderCount, p.unitsSold, `$${p.revenue.toFixed(2)}`]),
      );
    } else {
      pdf.addEmptyNote('No product sales recorded in this period.');
    }

    return pdf.build();
  }

  /**
   * Report-generation entry point for a future scheduled email job — reuses
   * the exact same aggregation as `exportPdf`. No cron/email wiring is added
   * here; `SchedulerModule` (`@nestjs/schedule`) and an OTP-only
   * `EmailService` already exist in this codebase but neither is wired to
   * this yet — see the analytics report for what a follow-up needs to do.
   */
  async generateScheduledReport(sellerId: string, storeId: string, range: string): Promise<Buffer> {
    return this.exportPdf(sellerId, storeId, { range });
  }
}
