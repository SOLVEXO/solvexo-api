/* eslint-disable prettier/prettier */
import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import {
  BucketGranularity,
  absoluteChange,
  bucketExpr,
  enumerateBuckets,
  enumerateDayKeys,
  localDateKey,
  rangeCacheKey,
  zonedStartOfDay,
  nextBucket as nextBucketUtil,
  percentChange,
  resolveDateRange,
  trendFor,
} from './utils/analytics-date.util';
import { round } from './utils/analytics-number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from './utils/analytics-cache.util';
import {
  aggregateProductSales as aggregateProductSalesUtil,
  allTimeCustomerAggregate as allTimeCustomerAggregateUtil,
  itemRefundSumField,
  notCancelledCond,
  periodTotals as periodTotalsUtil,
  repeatBuyerPercent as repeatBuyerPercentUtil,
  returningBuyerSet as returningBuyerSetUtil,
  ReportingCurrency,
  sellerOrderMatchStage,
  sumUSD,
  toReporting,
  unconvertibleCond,
  unconvertibleCountField,
} from './utils/order-aggregation.util';
import { resolveStoreTimeZone } from '../common/store-timezone.util';
import { toCsv } from './utils/csv.util';
import { PdfReportBuilder } from './utils/pdf-report.util';
import { getPaymentMethodLabel } from './utils/payment-method-label.util';
import { resolveCustomerIdentities, NOT_RECORDED_LABEL } from './utils/customer-identity.util';
import { forecastDailyDemand } from '../inventory/demand-forecast.util';

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
    return round(n);
  }

  // ─── Ownership + scope + caching ───────────────────────────────────────
  // Every seller analytics method below (except `today` and export/PDF, which
  // stay single-store) accepts `storeId: string | null | undefined` — a real
  // id scopes to that one store (ownership verified); omitting it scopes
  // across every store the seller owns instead, powering the cross-store
  // seller dashboard/analytics view with the exact same aggregation logic.

  private async verifyStoreOwnership(storeId: string, sellerId: string) {
    return verifyStoreOwnershipOrForbidden(this.r.storeModel, storeId, sellerId);
  }

  private async getOwnedStoreIds(sellerId: string): Promise<string[]> {
    const stores = await this.r.storeModel.find({ sellerId, isDelete: false }).select('_id').lean();
    return stores.map((s: any) => s._id.toString());
  }

  /** Resolves the `sellerOrders.storeId` match for either one verified store or every store the seller owns. */
  private async resolveScope(sellerId: string, storeId?: string | null): Promise<{ scope: Record<string, any>; storeIds: string[] }> {
    if (storeId) {
      await this.verifyStoreOwnership(storeId, sellerId);
      return { scope: { 'sellerOrders.storeId': storeId }, storeIds: [storeId] };
    }
    const storeIds = await this.getOwnedStoreIds(sellerId);
    return { scope: { 'sellerOrders.storeId': { $in: storeIds } }, storeIds };
  }

  /**
   * Scope + the store's reporting settings, Shopify-style: a single store's analytics are shown in ITS currency
   * (each order converted at the rate frozen on that order — see `toReporting`) and bucketed by ITS time zone. The
   * legacy cross-store scope (no storeId) has no single currency/zone, so it stays USD/UTC.
   */
  async resolveContext(sellerId: string, storeId?: string | null): Promise<{
    scope: Record<string, any>; storeIds: string[]; store: any | null; rc: ReportingCurrency | null; tz: string; currency: string;
  }> {
    if (!storeId) {
      const { scope, storeIds } = await this.resolveScope(sellerId, null);
      return { scope, storeIds, store: null, rc: null, tz: 'UTC', currency: 'USD' };
    }
    if (!isValidObjectId(storeId)) throw new ForbiddenException('Store not found or unauthorized');
    const store: any = await this.verifyStoreOwnership(storeId, sellerId);
    const currency = String(store.baseCurrency ?? 'USD').toUpperCase();
    let rc: ReportingCurrency | null = null;
    if (currency !== 'USD') {
      const latest: any = await this.r.exchangeRateModel
        .findOne({ currency, isRejected: false })
        .sort({ effectiveFrom: -1 })
        .select('ratePerUSD')
        .lean();
      rc = { code: currency, fallbackRatePerUSD: latest?.ratePerUSD > 0 ? latest.ratePerUSD : null };
    }
    return { scope: { 'sellerOrders.storeId': storeId }, storeIds: [storeId], store, rc, tz: resolveStoreTimeZone(store), currency };
  }

  private async cached<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    return withAnalyticsCache(this.redis, cacheKey, CACHE_TTL_SECONDS, compute);
  }

  /** `scopeLabel` is the real storeId for a single-store call, or `seller:<sellerId>` for the cross-store one — keeps their cache entries distinct. */
  private key(section: string, scopeLabel: string, query: Record<string, any>) {
    return buildAnalyticsCacheKey('analytics', scopeLabel, section, query);
  }

  private scopeLabel(sellerId: string, storeId?: string | null) {
    return storeId ?? `seller:${sellerId}`;
  }

  // ─── Shared aggregation building blocks ────────────────────────────────
  // Every seller-scoped Order aggregation starts the same way: unwind the
  // embedded `sellerOrders` array (there's no top-level storeId on Order —
  // an order can span multiple sellers) and match the resolved scope.
  // Cancelled sellerOrders are excluded from every revenue/order metric —
  // they represent no completed business activity by convention. This
  // scoping logic (and the aggregations below) is shared with
  // `AdminAnalyticsService` via `./utils/order-aggregation.util`.

  private matchStage(scope: Record<string, any>, from: Date, to: Date) {
    return sellerOrderMatchStage(from, to, scope);
  }

  private notCancelled() {
    return notCancelledCond();
  }

  /** Sum of item-level refunds for the current sellerOrder — `$sum` over an array field works as an array accumulator outside `$group`. */
  private itemRefundField() {
    return itemRefundSumField();
  }

  private async periodTotals(scope: Record<string, any>, from: Date, to: Date, rc: ReportingCurrency | null) {
    return periodTotalsUtil(this.r.orderModel, from, to, scope, rc);
  }

  private async repeatBuyerPercent(scope: Record<string, any>, from: Date, to: Date): Promise<number> {
    return repeatBuyerPercentUtil(this.r.orderModel, from, to, scope);
  }

  /** Buyers among `buyerIds` who already had a non-cancelled order within this scope before `from`. */
  private async returningBuyerSet(scope: Record<string, any>, buyerIds: string[], from: Date): Promise<Set<string>> {
    return returningBuyerSetUtil(this.r.orderModel, buyerIds, from, scope);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TODAY SUMMARY — store dashboard's "Today's Revenue" live card. Compares
  // today-so-far against the *same elapsed window* yesterday (not all of
  // yesterday) so the percent change is apples-to-apples regardless of what
  // time of day it's checked. Deliberately omits "visitors"/"conversion
  // rate" — there is no storefront visit/session tracking anywhere in this
  // codebase to compute them from (see subscriptions.service.ts's identical
  // disclaimer for subscriber conversion rate); inventing those numbers
  // would violate the app's "no fake data" rule, so the app hides those
  // stat cells instead of receiving placeholder values. Single-store only —
  // this is the per-store dashboard's widget, not the cross-store one.
  // ═══════════════════════════════════════════════════════════════════════

  private readonly TODAY_CACHE_TTL_SECONDS = 30; // short — card is labeled "Live"

  async getTodaySummary(sellerId: string, storeIdInput: string | null | undefined) {
    const storeId = this.requireStoreId(storeIdInput);
    const { scope, rc, tz, currency } = await this.resolveContext(sellerId, storeId);

    // "Today" is the store's local day (Shopify uses the store time zone), not the UTC day.
    const now = new Date();
    const todayStart = zonedStartOfDay(now, tz);
    const elapsedMs = now.getTime() - todayStart.getTime();
    const yesterdayStart = zonedStartOfDay(now, tz, -1);
    const yesterdaySameTime = new Date(yesterdayStart.getTime() + elapsedMs);

    return withAnalyticsCache(this.redis, this.key('today', storeId, { tz, currency }), this.TODAY_CACHE_TTL_SECONDS, async () => {
      const [today, yesterday] = await Promise.all([
        this.periodTotals(scope, todayStart, now, rc),
        this.periodTotals(scope, yesterdayStart, yesterdaySameTime, rc),
      ]);

      return {
        success: true,
        data: {
          currency,
          revenue: today.netRevenue,
          revenueChangePercent: percentChange(today.netRevenue, yesterday.netRevenue),
          ordersCount: today.orderCount,
          avgOrderValue: today.avgOrderValue,
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // A. OVERVIEW
  // ═══════════════════════════════════════════════════════════════════════

  async getOverview(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to, previousFrom, previousTo } = resolveDateRange(query, tz);
    const compare = query.compareToPreviousPeriod === true || query.compareToPreviousPeriod === 'true';

    return this.cached(this.key('overview', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency, compare }), async () => {
      const [current, previous, repeatBuyerPct, prevRepeatBuyerPct] = await Promise.all([
        this.periodTotals(scope, from, to, rc),
        this.periodTotals(scope, previousFrom, previousTo, rc),
        this.repeatBuyerPercent(scope, from, to),
        this.repeatBuyerPercent(scope, previousFrom, previousTo),
      ]);

      const returningSet = await this.returningBuyerSet(scope, current.buyerIds, from);
      const newCustomersCount = current.uniqueBuyerCount - returningSet.size;
      const returningCustomersCount = returningSet.size;

      const refundRatePercent = current.grossRevenue > 0 ? this.round((current.refundAmount / current.grossRevenue) * 100) : 0;

      const data: Record<string, any> = {
        period: { from, to },
        storeCount: storeIds.length,
        currency,
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

  async getRevenueOverTime(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to, granularity } = resolveDateRange(query, tz);

    return this.cached(this.key('revenue-over-time', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        {
          $addFields: {
            itemRefund: this.itemRefundField(),
            bucket: bucketExpr('$createdAt', granularity, tz),
          },
        },
        {
          $group: {
            _id: '$bucket',
            grossRevenue: { $sum: { $cond: [this.notCancelled(), { $ifNull: [toReporting('$sellerOrders.subtotal', rc), 0] }, 0] } },
            refundAmount: { $sum: { $cond: [this.notCancelled(), { $ifNull: [toReporting('$itemRefund', rc), 0] }, 0] } },
            unconvertibleOrderCount: { $sum: { $cond: [{ $and: [this.notCancelled(), unconvertibleCond(rc)] }, 1, 0] } },
          },
        },
      ]);

      const byBucket = new Map(rows.map((r: any) => [r._id.getTime(), r]));
      let totalUnconvertible = 0;
      const series = enumerateBuckets(from, to, granularity, tz).map((bucket) => {
        const row = byBucket.get(bucket.getTime());
        const gross = this.round(row?.grossRevenue ?? 0);
        const refund = this.round(row?.refundAmount ?? 0);
        totalUnconvertible += row?.unconvertibleOrderCount ?? 0;
        return { date: bucket, grossRevenue: gross, netRevenue: this.round(gross - refund) };
      });

      return {
        success: true,
        data: {
          granularity, currency, series,
          ...(totalUnconvertible > 0
            ? { note: `${totalUnconvertible} order(s) in this period have no recorded exchange rate and are excluded from these totals rather than guessed at.` }
            : {}),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B2. SALES FORECAST — real trend+seasonality forecasting (Holt's linear
  // exponential smoothing + day-of-week factor, `demand-forecast.util.ts`,
  // the same technique Inventory's Reorder Suggestions uses, applied here to
  // daily NET REVENUE instead of per-SKU units). Falls back to a plain
  // 30-day daily average whenever there isn't enough order history to
  // forecast responsibly (a new/low-volume store) — every seller always
  // gets an honest projected figure, never a confident-looking guess from
  // too little data. `method` on the response discloses which one was used.
  // ═══════════════════════════════════════════════════════════════════════

  async getSalesForecast(sellerId: string, storeId: string | null | undefined) {
    const { scope, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const to = new Date();
    const from = zonedStartOfDay(to, tz, -89);

    return this.cached(this.key('sales-forecast', this.scopeLabel(sellerId, storeId), { tz, currency }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        {
          $addFields: {
            itemRefund: this.itemRefundField(),
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
          },
        },
        {
          $group: {
            _id: '$day',
            netRevenue: {
              $sum: {
                $cond: [this.notCancelled(), { $ifNull: [{ $subtract: [toReporting('$sellerOrders.subtotal', rc), toReporting('$itemRefund', rc)] }, 0] }, 0],
              },
            },
          },
        },
      ]);

      const dailyRevenue = new Map<string, number>(rows.map((r: any) => [r._id, Math.max(0, this.round(r.netRevenue))]));
      const forecast = forecastDailyDemand(dailyRevenue);
      const thirtyDayCutoff = localDateKey(zonedStartOfDay(to, tz, -29), tz);
      const thirtyDaySum = Array.from(dailyRevenue.entries()).reduce((sum, [day, rev]) => (day >= thirtyDayCutoff ? sum + rev : sum), 0);
      const simpleAvg = thirtyDaySum / 30;
      const forecastedDailyRevenue = this.round(forecast ?? simpleAvg);

      return {
        success: true,
        data: {
          currency,
          method: forecast != null ? 'trend_seasonal' : 'simple_average',
          forecastedDailyRevenue,
          projectedNext7Days: this.round(forecastedDailyRevenue * 7),
          projectedNext30Days: this.round(forecastedDailyRevenue * 30),
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // B3. WEEKDAY PERFORMANCE — a real, honest insight for Marketing/Discounts:
  // which day of the week this store's sales are consistently weakest, over
  // the last 90 days, so a seller can target a discount/campaign at their
  // actual slow day instead of guessing. Same underlying day-of-week
  // averaging idea as the seasonality factor in `demand-forecast.util.ts`,
  // surfaced directly here since "which day is slow" is itself the useful
  // answer, not an intermediate step toward a forecast number.
  // ═══════════════════════════════════════════════════════════════════════

  private static readonly WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  /** Needs at least this many distinct sale-days in the 90-day window before
   *  a weekday comparison is considered meaningful (same guardrail spirit as
   *  `demand-forecast.util.ts`'s MIN_SALE_DAYS) — a near-empty store gets
   *  `null` rather than a misleading "your slowest day is X" from 2 data points. */
  private static readonly WEEKDAY_MIN_SALE_DAYS = 14;

  async getWeekdayPerformance(sellerId: string, storeId: string | null | undefined) {
    const { scope, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const to = new Date();
    const from = zonedStartOfDay(to, tz, -89);

    return this.cached(this.key('weekday-performance', this.scopeLabel(sellerId, storeId), { tz, currency }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        {
          $addFields: {
            itemRefund: this.itemRefundField(),
            day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
            weekday: { $dayOfWeek: { date: '$createdAt', timezone: tz } }, // 1=Sunday..7=Saturday
          },
        },
        {
          $group: {
            _id: { day: '$day', weekday: '$weekday' },
            netRevenue: {
              $sum: {
                $cond: [this.notCancelled(), { $ifNull: [{ $subtract: [toReporting('$sellerOrders.subtotal', rc), toReporting('$itemRefund', rc)] }, 0] }, 0],
              },
            },
          },
        },
      ]);

      if (rows.length < AnalyticsService.WEEKDAY_MIN_SALE_DAYS) {
        return { success: true, data: null };
      }

      // Average over EVERY calendar day of that weekday in the window (days with no sales count as 0) — averaging
      // only the days that had sales hid a weekday's empty days and skewed which day looked slowest.
      const totals = Array(7).fill(0);
      const counts = Array(7).fill(0);
      for (const day of enumerateDayKeys(from, to, tz)) {
        counts[new Date(`${day}T12:00:00Z`).getUTCDay()] += 1;
      }
      for (const row of rows as any[]) {
        totals[row._id.weekday - 1] += Math.max(0, row.netRevenue); // 1..7 -> 0..6
      }
      const averages = totals.map((t, i) => (counts[i] > 0 ? t / counts[i] : 0));
      const overallAvg = averages.reduce((a, b) => a + b, 0) / 7;
      if (overallAvg <= 0) return { success: true, data: null };

      let slowestIdx = 0;
      for (let i = 1; i < 7; i++) if (counts[i] > 0 && averages[i] < averages[slowestIdx]) slowestIdx = i;
      let busiestIdx = 0;
      for (let i = 1; i < 7; i++) if (averages[i] > averages[busiestIdx]) busiestIdx = i;

      return {
        success: true,
        data: {
          slowestDay: AnalyticsService.WEEKDAY_LABELS[slowestIdx],
          slowestDayBelowAveragePercent: this.round(((overallAvg - averages[slowestIdx]) / overallAvg) * 100),
          busiestDay: AnalyticsService.WEEKDAY_LABELS[busiestIdx],
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C. ORDERS OVER TIME
  // ═══════════════════════════════════════════════════════════════════════

  async getOrdersOverTime(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to, granularity } = resolveDateRange(query, tz);

    return this.cached(this.key('orders-over-time', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $addFields: { bucket: bucketExpr('$createdAt', granularity, tz) } },
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
      const series = enumerateBuckets(from, to, granularity, tz).map((bucket) => {
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

  async getTrafficSources(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);

    return this.cached(this.key('traffic-sources', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        {
          $group: {
            _id: { $ifNull: ['$attributionSource', 'other'] },
            count: { $sum: 1 },
            revenue: sumUSD('$sellerOrders.subtotal', rc),
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

  async getTopProducts(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);
    const limit = Number(query.limit) || 10;
    const sort = query.sort === 'units_sold' ? 'units_sold' : 'revenue';

    return this.cached(this.key('top-products', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency, limit, sort }), async () => {
      const rows = await this.aggregateProductSales(scope, from, to, rc);
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

  /** Shared item-level sales aggregation reused by top-products and product-performance (and by admin analytics, platform-wide). */
  private async aggregateProductSales(scope: Record<string, any>, from: Date, to: Date, rc: ReportingCurrency | null) {
    return aggregateProductSalesUtil(this.r.orderModel, from, to, scope, rc);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // E2. TRENDING PRODUCTS — real week-over-week growth detection (last 7
  // days vs the prior 7 days, per product), independent of whatever date
  // range the analytics filter bar happens to be set to. Surfaces products
  // with genuinely rising demand so a seller can react (restock, feature,
  // discount) before the trend fades or the shelf empties. Deliberately NOT
  // the same trend+seasonality model as Sales Forecast/Reorder Suggestions —
  // week-over-week comparison is the right, simpler tool for "what's hot
  // right now," not a multi-week smoothed projection. A product needs a
  // minimum recent volume to qualify, so "300% up" noise from a product that
  // sold 1 unit instead of 0 never surfaces.
  // ═══════════════════════════════════════════════════════════════════════

  private static readonly TRENDING_MIN_UNITS = 3;

  async getTrendingProducts(sellerId: string, storeId: string | null | undefined) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    return this.cached(this.key('trending-products', this.scopeLabel(sellerId, storeId), { tz, currency }), async () => {
      const [recent, prior] = await Promise.all([
        this.aggregateProductSales(scope, sevenDaysAgo, now, rc),
        this.aggregateProductSales(scope, fourteenDaysAgo, sevenDaysAgo, rc),
      ]);
      const priorByProduct = new Map(prior.map((r) => [r.productId, r.unitsSold]));

      const trending = recent
        .filter((r) => r.unitsSold >= AnalyticsService.TRENDING_MIN_UNITS)
        .map((r) => {
          const priorUnits = priorByProduct.get(r.productId) ?? 0;
          // `null` = no prior-week baseline to compare against (a genuinely
          // new/rarely-sold product suddenly moving) rather than a fake "∞%".
          const growthPercent = priorUnits > 0 ? this.round(((r.unitsSold - priorUnits) / priorUnits) * 100) : null;
          return { productId: r.productId, name: r.name, unitsSoldLast7Days: r.unitsSold, unitsSoldPrior7Days: priorUnits, growthPercent };
        })
        .filter((r) => r.growthPercent === null || r.growthPercent > 0)
        .sort((a, b) => {
          if (a.growthPercent === null && b.growthPercent === null) return b.unitsSoldLast7Days - a.unitsSoldLast7Days;
          if (a.growthPercent === null) return 1;
          if (b.growthPercent === null) return -1;
          return b.growthPercent - a.growthPercent;
        })
        .slice(0, 5);

      return { success: true, data: trending };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F. CUSTOMER ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  /** All-time per-customer aggregate for this scope — the base for LTV, and for classifying new vs returning within any period. */
  private async allTimeCustomerAggregate(scope: Record<string, any>, rc: ReportingCurrency | null) {
    return allTimeCustomerAggregateUtil(this.r.orderModel, scope, rc);
  }

  async getCustomerAnalytics(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to, granularity } = resolveDateRange(query, tz);

    return this.cached(this.key('customers', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency }), async () => {
      const allTime = await this.allTimeCustomerAggregate(scope, rc);
      const firstOrderMap = new Map(allTime.map((c) => [c.userId, c.firstOrderAt]));

      // New vs returning per bucket, using each buyer's all-time first order date within this scope.
      const periodRows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $addFields: { bucket: bucketExpr('$createdAt', granularity, tz) } },
        { $group: { _id: { bucket: '$bucket', userId: { $ifNull: ['$customerId', '$userId'] } } } },
      ]);

      const bucketTotals = new Map<number, { newCustomers: number; returningCustomers: number }>();
      for (const row of periodRows) {
        const bucketTime = row._id.bucket.getTime();
        const firstOrderAt = firstOrderMap.get(row._id.userId);
        // "New" in this bucket = their all-time first order within this scope falls within it.
        const isNew = !!firstOrderAt && firstOrderAt >= row._id.bucket && firstOrderAt < this.nextBucket(row._id.bucket, granularity, tz);
        const entry = bucketTotals.get(bucketTime) ?? { newCustomers: 0, returningCustomers: 0 };
        if (isNew) entry.newCustomers += 1; else entry.returningCustomers += 1;
        bucketTotals.set(bucketTime, entry);
      }

      const series = enumerateBuckets(from, to, granularity, tz).map((bucket) => {
        const totals = bucketTotals.get(bucket.getTime()) ?? { newCustomers: 0, returningCustomers: 0 };
        return { date: bucket, ...totals };
      });

      // Lifetime value summary + top customers (all-time LTV within this scope).
      const avgLifetimeValue = allTime.length > 0
        ? this.round(allTime.reduce((sum, c) => sum + c.lifetimeValue, 0) / allTime.length)
        : 0;

      const topByLtv = [...allTime].sort((a, b) => b.lifetimeValue - a.lifetimeValue).slice(0, 10);
      const identityMap = await resolveCustomerIdentities(this.r.userModel, this.r.orderModel, topByLtv.map((c) => c.userId));

      const topCustomers = topByLtv.map((c) => {
        const identity = identityMap.get(c.userId)!;
        return {
          userId: c.userId,
          name: identity.name,
          email: identity.email,
          totalOrders: c.totalOrders,
          lifetimeValue: c.lifetimeValue,
        };
      });

      // Geographic breakdown — physical orders only (digital orders have no shippingAddress).
      const geoRows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, shippingAddress: { $ne: null } } },
        { $group: { _id: { state: '$shippingAddress.state', country: '$shippingAddress.country' }, orders: { $sum: 1 }, revenue: sumUSD('$sellerOrders.subtotal', rc), unconvertibleOrderCount: unconvertibleCountField(rc) } },
        { $sort: { revenue: -1 } },
      ]);

      // Country breakdown — a sibling of the state-level one above, for a
      // multi-currency/international-selling store where "state" alone
      // doesn't distinguish e.g. a Pakistani buyer from a UK one. Uses
      // `shippingAddress.country` (ISO-3166 alpha-2, already stamped onto
      // Order at checkout — see Address.country's own doc comment).
      const countryRows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' }, shippingAddress: { $ne: null } } },
        { $group: { _id: '$shippingAddress.country', orders: { $sum: 1 }, revenue: sumUSD('$sellerOrders.subtotal', rc), unconvertibleOrderCount: unconvertibleCountField(rc) } },
        { $sort: { revenue: -1 } },
      ]);
      const geoUnconvertibleTotal = geoRows.reduce((s: number, r: any) => s + (r.unconvertibleOrderCount ?? 0), 0)
        + countryRows.reduce((s: number, r: any) => s + (r.unconvertibleOrderCount ?? 0), 0);

      return {
        success: true,
        data: {
          granularity,
          newVsReturning: series,
          averageLifetimeValue: avgLifetimeValue,
          topCustomersByLtv: topCustomers,
          geographicBreakdown: geoRows.map((r: any) => ({
            state: r._id?.state || NOT_RECORDED_LABEL,
            country: r._id?.country || NOT_RECORDED_LABEL,
            orders: r.orders,
            revenue: this.round(r.revenue),
          })),
          countryBreakdown: countryRows.map((r: any) => ({
            country: r._id || NOT_RECORDED_LABEL,
            orders: r.orders,
            revenue: this.round(r.revenue),
          })),
          ...(geoUnconvertibleTotal > 0
            ? { note: `${geoUnconvertibleTotal} order(s) have no recorded exchange rate and are excluded from these revenue figures rather than guessed at.` }
            : {}),
        },
      };
    });
  }

  private nextBucket(bucket: Date, granularity: BucketGranularity, tz: string): Date {
    return nextBucketUtil(bucket, granularity, tz);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F2. PRODUCT PERFORMANCE (paginated, beyond top-N)
  // ═══════════════════════════════════════════════════════════════════════

  async getProductPerformance(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    return this.cached(this.key('product-performance', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency, page, limit }), async () => {
      const [sales, products] = await Promise.all([
        this.aggregateProductSales(scope, from, to, rc),
        this.r.productModel.find({ storeId: { $in: storeIds }, isDelete: false }).select('name').lean(),
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

  async getInventoryInsights(sellerId: string, storeId: string | null | undefined) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);

    return this.cached(this.key('inventory-insights', this.scopeLabel(sellerId, storeId), { tz, currency }), async () => {
      // Sell-through measured over the trailing 30 days — a fixed, well-understood window for a store-wide inventory snapshot (this endpoint has no range param).
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 30);

      const [products, sales30d] = await Promise.all([
        this.r.productModel.find({ storeId: { $in: storeIds }, isDelete: false, status: 'active' }).select('name').lean(),
        this.aggregateProductSales(scope, from, to, rc),
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

  async getPaymentMethods(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);

    return this.cached(this.key('payment-methods', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency }), async () => {
      const rows = await this.r.orderModel.aggregate([
        ...this.matchStage(scope, from, to),
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: '$paymentType', count: { $sum: 1 }, revenue: sumUSD('$sellerOrders.subtotal', rc) } },
      ]);

      return {
        success: true,
        data: rows.map((r: any) => ({
          paymentType: r._id,
          label: getPaymentMethodLabel(r._id),
          orderCount: r.count,
          revenue: this.round(r.revenue),
        })),
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F5. REVENUE BREAKDOWN — one-time order revenue
  // ═══════════════════════════════════════════════════════════════════════

  async getRevenueBreakdown(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, storeIds, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);

    return this.cached(this.key('revenue-breakdown', this.scopeLabel(sellerId, storeId), { r: rangeCacheKey(query, tz), currency }), async () => {
      const orderTotals = await this.periodTotals(scope, from, to, rc);

      return {
        success: true,
        data: {
          oneTimeOrderRevenue: orderTotals.netRevenue,
          totalRevenue: orderTotals.netRevenue,
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F6. ONLINE STORE SESSIONS + CONVERSION (Shopify: Sessions, Conversion rate,
  // conversion funnel, sessions by device / location / traffic source /
  // referrer / landing page). Built on StorefrontSession — visits recorded from
  // the tracking launch forward only; `trackingSince` tells the UI when that was.
  // ═══════════════════════════════════════════════════════════════════════

  private static sessionTotalsGroup() {
    return {
      _id: null,
      sessions: { $sum: 1 },
      pageViews: { $sum: '$pageViews' },
      bounced: { $sum: { $cond: [{ $lte: ['$pageViews', 1] }, 1, 0] } },
      returning: { $sum: { $cond: ['$returningVisitor', 1, 0] } },
      addedToCart: { $sum: { $cond: ['$addedToCart', 1, 0] } },
      reachedCheckout: { $sum: { $cond: ['$reachedCheckout', 1, 0] } },
      converted: { $sum: { $cond: ['$converted', 1, 0] } },
    };
  }

  private static pct(part: number, whole: number) {
    return whole > 0 ? round((part / whole) * 100) : 0;
  }

  async getSessionsReport(sellerId: string, storeIdInput: string | null | undefined, query: any) {
    const storeId = this.requireStoreId(storeIdInput);
    const { tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to, previousFrom, previousTo, granularity } = resolveDateRange(query, tz);
    const model = this.r.storefrontSessionModel;

    return this.cached(this.key('sessions', storeId, { r: rangeCacheKey(query, tz), currency }), async () => {
      const breakdown = (field: string, limit: number): any[] => [
        { $group: { _id: { $ifNull: [field, null] }, sessions: { $sum: 1 }, converted: { $sum: { $cond: ['$converted', 1, 0] } } } },
        { $sort: { sessions: -1 } },
        { $limit: limit },
      ];
      const [facet] = await model.aggregate([
        { $match: { storeId, startedAt: { $gte: from, $lte: to } } },
        {
          $facet: {
            totals: [{ $group: AnalyticsService.sessionTotalsGroup() }],
            visitors: [{ $group: { _id: '$visitorId' } }, { $count: 'n' }],
            overTime: [
              { $group: { _id: bucketExpr('$startedAt', granularity, tz), sessions: { $sum: 1 }, converted: { $sum: { $cond: ['$converted', 1, 0] } } } },
            ],
            byDevice: breakdown('$deviceType', 5),
            byCountry: breakdown('$country', 15),
            bySource: breakdown('$trafficSource', 10),
            byReferrer: [{ $match: { referrerHost: { $ne: null } } }, ...breakdown('$referrerHost', 10)],
            byLandingPage: breakdown('$landingPath', 10),
          },
        },
      ]);
      const [prevTotals, firstSession] = await Promise.all([
        model.aggregate([{ $match: { storeId, startedAt: { $gte: previousFrom, $lt: previousTo } } }, { $group: AnalyticsService.sessionTotalsGroup() }]),
        model.findOne({ storeId }).sort({ startedAt: 1 }).select('startedAt').lean(),
      ]);

      const t = facet?.totals?.[0] ?? { sessions: 0, pageViews: 0, bounced: 0, returning: 0, addedToCart: 0, reachedCheckout: 0, converted: 0 };
      const p = prevTotals[0] ?? { sessions: 0, converted: 0 };
      const conversionRate = AnalyticsService.pct(t.converted, t.sessions);
      const prevConversionRate = AnalyticsService.pct(p.converted, p.sessions);
      const byBucket = new Map<number, any>((facet?.overTime ?? []).map((r: any) => [new Date(r._id).getTime(), r]));
      const rows = (list: any[] | undefined, key: string) => (list ?? []).map((r: any) => ({
        [key]: r._id ?? null,
        sessions: r.sessions,
        conversionRate: AnalyticsService.pct(r.converted, r.sessions),
      }));

      return {
        success: true,
        data: {
          granularity,
          trackingSince: (firstSession as any)?.startedAt ?? null,
          sessions: t.sessions,
          sessionsChangePercent: percentChange(t.sessions, p.sessions),
          visitors: facet?.visitors?.[0]?.n ?? 0,
          returningVisitorRate: AnalyticsService.pct(t.returning, t.sessions),
          pageViews: t.pageViews,
          pagesPerSession: t.sessions > 0 ? round(t.pageViews / t.sessions) : 0,
          bounceRate: AnalyticsService.pct(t.bounced, t.sessions),
          conversionRate,
          conversionRateChange: round(conversionRate - prevConversionRate),
          funnel: {
            sessions: t.sessions,
            addedToCart: t.addedToCart,
            addedToCartRate: AnalyticsService.pct(t.addedToCart, t.sessions),
            reachedCheckout: t.reachedCheckout,
            reachedCheckoutRate: AnalyticsService.pct(t.reachedCheckout, t.sessions),
            converted: t.converted,
            conversionRate,
          },
          series: enumerateBuckets(from, to, granularity, tz).map((bucket) => {
            const row = byBucket.get(bucket.getTime());
            return { date: bucket, sessions: row?.sessions ?? 0, conversionRate: AnalyticsService.pct(row?.converted ?? 0, row?.sessions ?? 0) };
          }),
          byDevice: rows(facet?.byDevice, 'deviceType'),
          byCountry: rows(facet?.byCountry, 'country'),
          byTrafficSource: rows(facet?.bySource, 'source'),
          byReferrer: rows(facet?.byReferrer, 'referrer'),
          byLandingPage: rows(facet?.byLandingPage, 'path'),
        },
      };
    });
  }

  /** Shopify Live View: visitors active in the last 5 minutes + today's activity, refreshed every few seconds by the UI. */
  private static readonly LIVE_WINDOW_MS = 5 * 60_000;

  async getLiveView(sellerId: string, storeIdInput: string | null | undefined) {
    const storeId = this.requireStoreId(storeIdInput);
    const { scope, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const now = new Date();
    const activeSince = new Date(now.getTime() - AnalyticsService.LIVE_WINDOW_MS);
    const todayStart = zonedStartOfDay(now, tz);
    const model = this.r.storefrontSessionModel;

    return withAnalyticsCache(this.redis, this.key('live', storeId, { tz, currency }), 10, async () => {
      const [[live], [today], todayOrders] = await Promise.all([
        model.aggregate([
          { $match: { storeId, lastSeenAt: { $gte: activeSince } } },
          {
            $facet: {
              counts: [{
                $group: {
                  _id: null,
                  visitorsNow: { $sum: 1 },
                  activeCarts: { $sum: { $cond: [{ $and: ['$addedToCart', { $not: ['$reachedCheckout'] }, { $not: ['$converted'] }] }, 1, 0] } },
                  checkingOut: { $sum: { $cond: [{ $and: ['$reachedCheckout', { $not: ['$converted'] }] }, 1, 0] } },
                  purchased: { $sum: { $cond: ['$converted', 1, 0] } },
                },
              }],
              pages: [{ $group: { _id: '$currentPath', visitors: { $sum: 1 } } }, { $sort: { visitors: -1 } }, { $limit: 8 }],
              countries: [{ $group: { _id: '$country', visitors: { $sum: 1 } } }, { $sort: { visitors: -1 } }, { $limit: 8 }],
              devices: [{ $group: { _id: '$deviceType', visitors: { $sum: 1 } } }, { $sort: { visitors: -1 } }],
            },
          },
        ]),
        model.aggregate([
          { $match: { storeId, startedAt: { $gte: todayStart } } },
          { $group: { _id: null, sessions: { $sum: 1 }, converted: { $sum: { $cond: ['$converted', 1, 0] } } } },
        ]),
        this.periodTotals(scope, todayStart, now, rc),
      ]);
      const c = live?.counts?.[0] ?? { visitorsNow: 0, activeCarts: 0, checkingOut: 0, purchased: 0 };
      return {
        success: true,
        data: {
          asOf: now,
          currency,
          visitorsNow: c.visitorsNow,
          activeCarts: c.activeCarts,
          checkingOut: c.checkingOut,
          purchasedNow: c.purchased,
          topPages: (live?.pages ?? []).map((r: any) => ({ path: r._id ?? '/', visitors: r.visitors })),
          countries: (live?.countries ?? []).map((r: any) => ({ country: r._id ?? null, visitors: r.visitors })),
          devices: (live?.devices ?? []).map((r: any) => ({ deviceType: r._id ?? 'desktop', visitors: r.visitors })),
          today: {
            sessions: today?.sessions ?? 0,
            conversionRate: AnalyticsService.pct(today?.converted ?? 0, today?.sessions ?? 0),
            orders: todayOrders.orderCount,
            sales: todayOrders.netRevenue,
          },
        },
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // F.5 SAVED REPORTS — real "Reports" permission (Shopify's actual scope):
  // a named, persisted filter configuration a seller can re-run later
  // instead of reconfiguring the AnalyticsFilterBar from scratch. Running a
  // saved report is just its `config` spread back into the existing
  // `export` call — no separate report-execution engine.
  // ═══════════════════════════════════════════════════════════════════════

  async listSavedReports(sellerId: string, storeId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    const reports = await this.r.savedReportModel.find({ storeId }).sort({ createdAt: -1 }).lean();
    return { success: true, data: reports };
  }

  async createSavedReport(sellerId: string, storeId: string, body: { name: string; config?: Record<string, any> }) {
    await this.verifyStoreOwnership(storeId, sellerId);
    if (!body?.name?.trim()) throw new BadRequestException('A report name is required');
    const cfg = (body.config ?? {}) as Record<string, any>;
    const report = await this.r.savedReportModel.create({
      storeId, sellerId, name: body.name.trim(),
      config: {
        range: cfg.range ?? '30d',
        from: cfg.from ?? null,
        to: cfg.to ?? null,
        compareToPreviousPeriod: !!cfg.compareToPreviousPeriod,
        format: cfg.format ?? 'csv',
        section: cfg.section ?? null,
      },
    });
    return { success: true, message: 'Report saved', data: report };
  }

  async deleteSavedReport(sellerId: string, storeId: string, reportId: string) {
    await this.verifyStoreOwnership(storeId, sellerId);
    if (!isValidObjectId(reportId)) throw new NotFoundException('Report not found');
    const result = await this.r.savedReportModel.deleteOne({ _id: reportId, storeId });
    if (result.deletedCount === 0) throw new NotFoundException('Report not found');
    return { success: true, message: 'Report deleted' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // G. EXPORT — single-store only for now; not part of the cross-store view.
  // ═══════════════════════════════════════════════════════════════════════

  private requireStoreId(storeId: string | null | undefined): string {
    if (!storeId) throw new BadRequestException('storeId is required');
    return storeId;
  }

  async exportCsv(sellerId: string, storeIdInput: string | null | undefined, query: any): Promise<string> {
    const storeId = this.requireStoreId(storeIdInput);
    const { scope, rc, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);
    const section = query.section ?? 'revenue';

    switch (section) {
      case 'orders': {
        const rows = await this.r.orderModel.aggregate([
          ...this.matchStage(scope, from, to),
          {
            $project: {
              _id: 0, orderNumber: 1, createdAt: 1, status: '$sellerOrders.status',
              currency: { $ifNull: ['$currency', 'USD'] },
              subtotal: '$sellerOrders.subtotal',
              // Additive — see admin-analytics.service.ts#exportCsv's same
              // column for why this sits alongside (never replaces) the raw
              // native-currency `subtotal` above.
              subtotalReport: toReporting('$sellerOrders.subtotal', rc),
              paymentType: 1,
            },
          },
          { $sort: { createdAt: -1 } },
          { $limit: 5000 },
        ]);
        return toCsv(
          ['Order Number', 'Date', 'Status', 'Order Currency', 'Subtotal (order currency)', `Subtotal (${currency})`, 'Payment Type'],
          rows.map((r: any) => [r.orderNumber, localDateKey(new Date(r.createdAt), tz), r.status, r.currency, Number(r.subtotal ?? 0).toFixed(2), r.subtotalReport == null ? 'N/A' : r.subtotalReport.toFixed(2), getPaymentMethodLabel(r.paymentType)]),
        );
      }
      case 'products': {
        const rows = await this.aggregateProductSales(scope, from, to, rc);
        rows.sort((a, b) => b.netRevenue - a.netRevenue);
        return toCsv(
          ['Product ID', 'Name', 'Order Count', 'Units Sold', `Gross Revenue (${currency})`, `Refunded (${currency})`, `Net Revenue (${currency})`],
          rows.map((r) => [r.productId, r.name, r.orderCount, r.unitsSold, r.grossRevenue.toFixed(2), r.refundedAmount.toFixed(2), r.netRevenue.toFixed(2)]),
        );
      }
      case 'customers': {
        const allTime = await this.allTimeCustomerAggregate(scope, rc);
        allTime.sort((a, b) => b.lifetimeValue - a.lifetimeValue);
        const identityMap = await resolveCustomerIdentities(this.r.userModel, this.r.orderModel, allTime.map((c) => c.userId));
        return toCsv(
          ['Customer', 'Email', 'Total Orders', `Lifetime Value (${currency})`],
          allTime.map((c) => {
            const identity = identityMap.get(c.userId)!;
            return [identity.name, identity.email, c.totalOrders, c.lifetimeValue.toFixed(2)];
          }),
        );
      }
      case 'revenue':
      default: {
        const revenueData = await this.getRevenueOverTime(sellerId, storeId, query);
        return toCsv(
          ['Date', `Gross Revenue (${currency})`, `Net Revenue (${currency})`],
          revenueData.data.series.map((s: any) => [localDateKey(new Date(s.date), tz), s.grossRevenue.toFixed(2), s.netRevenue.toFixed(2)]),
        );
      }
    }
  }

  async exportPdf(sellerId: string, storeIdInput: string | null | undefined, query: any): Promise<Buffer> {
    const storeId = this.requireStoreId(storeIdInput);
    const { store, tz, currency } = await this.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);
    const money = (n: number) => `${currency} ${Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const day = (d: Date | string) => localDateKey(new Date(d), tz);

    const [overview, revenue, traffic, topProducts] = await Promise.all([
      this.getOverview(sellerId, storeId, query),
      this.getRevenueOverTime(sellerId, storeId, query),
      this.getTrafficSources(sellerId, storeId, query),
      this.getTopProducts(sellerId, storeId, { ...query, limit: 10 }),
    ]);

    const rangeLabel = `${day(from)} to ${day(to)}`;
    const pdf = await PdfReportBuilder.create(`${store.name} — Analytics Report`, `Period: ${rangeLabel}`);

    pdf.addSectionHeading('Overview');
    pdf.addKeyValueGrid([
      { label: 'Total Revenue (net)', value: money(overview.data.totalRevenue) },
      { label: 'Gross Revenue', value: money(overview.data.grossRevenue) },
      { label: 'Total Orders', value: `${overview.data.totalOrders}` },
      { label: 'Avg Order Value', value: money(overview.data.avgOrderValue) },
      { label: 'Repeat Buyers', value: `${overview.data.repeatBuyerPercent}%` },
      { label: 'Refund Rate', value: `${overview.data.refundRatePercent}%` },
    ]);

    pdf.addSectionHeading('Revenue Over Time');
    if (revenue.data.series.length > 0) {
      pdf.addTable(
        ['Date', 'Gross', 'Net'],
        revenue.data.series.map((s: any) => [day(s.date), money(s.grossRevenue), money(s.netRevenue)]),
      );
    } else {
      pdf.addEmptyNote('No revenue recorded in this period.');
    }

    pdf.addSectionHeading('Traffic Sources');
    pdf.addTable(
      ['Source', 'Orders', 'Revenue', '%'],
      traffic.data.breakdown.map((b: any) => [b.source, b.count, money(b.revenue), `${b.percent}%`]),
    );

    pdf.addSectionHeading('Top Products by Revenue');
    if (topProducts.data.length > 0) {
      pdf.addTable(
        ['Product', 'Orders', 'Units', 'Revenue'],
        topProducts.data.map((p: any) => [p.name, p.orderCount, p.unitsSold, money(p.revenue)]),
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
