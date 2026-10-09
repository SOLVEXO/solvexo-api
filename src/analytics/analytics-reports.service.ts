/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { AnalyticsService } from './analytics.service';
import { bucketExpr, enumerateBuckets, localDateKey, percentChange, rangeCacheKey, resolveDateRange, zonedParts, zonedStartOfDay } from './utils/analytics-date.util';
import { round } from './utils/analytics-number.util';
import { buildAnalyticsCacheKey, withAnalyticsCache } from './utils/analytics-cache.util';
import { itemRefundSumField, ReportingCurrency, sellerOrderMatchStage, sumUSD } from './utils/order-aggregation.util';
import { toCsv } from './utils/csv.util';
import { availableStock } from '../common/stock-availability.util';

const CACHE_TTL_SECONDS = 600;
export const SALES_BY_DIMENSIONS = ['variant', 'discount', 'channel'] as const;
export type SalesByDimension = typeof SALES_BY_DIMENSIONS[number];

/** Report CSVs the seller can export (in addition to AnalyticsService's revenue/orders/products/customers). */
export const REPORT_EXPORT_SECTIONS = ['sales-summary', 'sales-by-variant', 'sales-by-discount', 'sales-by-channel', 'cohorts', 'inventory-abc'] as const;

/** Sum over a sellerOrder's line items of an expression on `$$i` (each line). */
const sumItems = (inExpr: any) => ({ $sum: { $map: { input: '$sellerOrders.items', as: 'i', in: inExpr } } });
const n = (field: string) => ({ $ifNull: [field, 0] });
/** Discounts Shopify reports as "Discounts": codes, automatic discounts, campaigns, member pricing. */
const LINE_DISCOUNTS = { $add: [n('$$i.couponDiscountUSD'), n('$$i.campaignDiscountUSD'), n('$$i.autoDiscountUSD'), n('$$i.subscriberDiscountUSD')] };
/**
 * Gross sales of a line = its price before any discount. `totalPrice` already has every discount AND the gift-card /
 * store-credit share taken off (see CheckoutService distribute*), so they are added back — gift cards and store
 * credit are a way of PAYING (Shopify), not a discount on sales.
 */
const LINE_GROSS = { $add: [n('$$i.totalPrice'), LINE_DISCOUNTS, n('$$i.giftCardDiscountUSD'), n('$$i.storeCreditDiscountUSD')] };

export interface MoneyTotals { orders: number; grossSales: number; discounts: number; returns: number; netSales: number; shipping: number; taxes: number; totalSales: number }

/**
 * Shopify-style report library for one store: Finance/Sales summary (gross → discounts → returns → net → shipping →
 * taxes → total), sales by variant / discount / channel, customer cohorts and inventory ABC analysis. Everything is in
 * the STORE currency (orders converted at their own frozen rate) and the store time zone — see
 * `AnalyticsService.resolveContext`.
 */
@Injectable()
export class AnalyticsReportsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly redis: RedisService,
    private readonly analytics: AnalyticsService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  private async context(sellerId: string, storeId: string | null | undefined) {
    if (!storeId) throw new BadRequestException('storeId is required');
    return this.analytics.resolveContext(sellerId, storeId);
  }

  private cached<T>(storeId: string, section: string, query: Record<string, any>, compute: () => Promise<T>) {
    return withAnalyticsCache(this.redis, buildAnalyticsCacheKey('analytics-reports', storeId, section, query), CACHE_TTL_SECONDS, compute);
  }

  /** Per-sellerOrder money fields (order currency), ready to be summed into the report currency. */
  private static moneyFields() {
    return {
      grossSales: sumItems(LINE_GROSS),
      discounts: sumItems(LINE_DISCOUNTS),
      returns: itemRefundSumField(),
      // Shipping is charged per order: a multi-store order's fee is shared by each store's subtotal.
      shipping: {
        $cond: [
          { $gt: [n('$subtotal'), 0] },
          { $multiply: [n('$shippingFee'), { $divide: [n('$sellerOrders.subtotal'), '$subtotal'] }] },
          { $cond: [{ $eq: [{ $size: { $ifNull: ['$sellerOrders', []] } }, 1] }, n('$shippingFee'), 0] },
        ],
      },
      taxes: n('$sellerOrders.taxAmount'),
    };
  }

  private static totalsGroup(rc: ReportingCurrency | null, id: any) {
    return {
      _id: id,
      orders: { $sum: 1 },
      grossSales: sumUSD('$m.grossSales', rc),
      discounts: sumUSD('$m.discounts', rc),
      returns: sumUSD('$m.returns', rc),
      shipping: sumUSD('$m.shipping', rc),
      taxes: sumUSD('$m.taxes', rc),
    };
  }

  private static finish(row: any): MoneyTotals {
    const grossSales = round(row?.grossSales ?? 0);
    const discounts = round(row?.discounts ?? 0);
    const returns = round(row?.returns ?? 0);
    const shipping = round(row?.shipping ?? 0);
    const taxes = round(row?.taxes ?? 0);
    const netSales = round(grossSales - discounts - returns);
    return { orders: row?.orders ?? 0, grossSales, discounts, returns, netSales, shipping, taxes, totalSales: round(netSales + shipping + taxes) };
  }

  private orderStages(scope: Record<string, any>, from: Date, to: Date) {
    return [
      ...sellerOrderMatchStage(from, to, scope),
      { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $addFields: { m: AnalyticsReportsService.moneyFields() } },
    ];
  }

  // ─── Sales / Finance summary ─────────────────────────────────────────────

  async getSalesSummary(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, rc, tz, currency } = await this.context(sellerId, storeId);
    const { from, to, previousFrom, previousTo, granularity } = resolveDateRange(query, tz);

    return this.cached(storeId!, 'sales-summary', { r: rangeCacheKey(query, tz), currency }, async () => {
      const [[facet], [prev]] = await Promise.all([
        this.r.orderModel.aggregate([
          ...this.orderStages(scope, from, to),
          { $addFields: { bucket: bucketExpr('$createdAt', granularity, tz) } },
          {
            $facet: {
              totals: [{ $group: AnalyticsReportsService.totalsGroup(rc, null) }],
              series: [{ $group: AnalyticsReportsService.totalsGroup(rc, '$bucket') }],
            },
          },
        ]),
        this.r.orderModel.aggregate([...this.orderStages(scope, previousFrom, previousTo), { $group: AnalyticsReportsService.totalsGroup(rc, null) }]),
      ]);
      const totals = AnalyticsReportsService.finish(facet?.totals?.[0]);
      const previous = AnalyticsReportsService.finish(prev);
      const byBucket = new Map<number, any>((facet?.series ?? []).map((r: any) => [new Date(r._id).getTime(), r]));
      const change: Record<string, number | null> = {};
      for (const k of Object.keys(totals) as (keyof MoneyTotals)[]) change[k] = percentChange(totals[k], previous[k]);

      return {
        success: true,
        data: {
          currency,
          granularity,
          period: { from, to },
          previousPeriod: { from: previousFrom, to: previousTo },
          totals,
          previous,
          changePercent: change,
          series: enumerateBuckets(from, to, granularity, tz).map((bucket) => ({ date: bucket, ...AnalyticsReportsService.finish(byBucket.get(bucket.getTime())) })),
          note: 'Returns include the tax share refunded on each returned line. Gift cards and store credit are payment methods, so they are included in sales (not discounts).',
        },
      };
    });
  }

  // ─── Sales by variant / discount / channel ───────────────────────────────

  async getSalesBy(sellerId: string, storeId: string | null | undefined, query: any) {
    const dimension = String(query.dimension ?? 'variant') as SalesByDimension;
    if (!SALES_BY_DIMENSIONS.includes(dimension)) throw new BadRequestException(`dimension must be one of ${SALES_BY_DIMENSIONS.join(', ')}`);
    const { scope, rc, tz, currency } = await this.context(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);

    return this.cached(storeId!, `sales-by-${dimension}`, { r: rangeCacheKey(query, tz), currency }, async () => {
      const rows = dimension === 'variant'
        ? await this.salesByVariant(scope, from, to, rc)
        : dimension === 'discount'
          ? await this.salesByDiscount(scope, from, to, rc)
          : await this.salesByChannel(storeId!, scope, from, to, rc);
      return { success: true, data: { currency, dimension, period: { from, to }, rows } };
    });
  }

  private async salesByVariant(scope: Record<string, any>, from: Date, to: Date, rc: ReportingCurrency | null) {
    const rows = await this.r.orderModel.aggregate([
      ...sellerOrderMatchStage(from, to, scope),
      { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $unwind: '$sellerOrders.items' },
      {
        $addFields: {
          li: {
            gross: { $let: { vars: { i: '$sellerOrders.items' }, in: LINE_GROSS } },
            discounts: { $let: { vars: { i: '$sellerOrders.items' }, in: LINE_DISCOUNTS } },
            returns: n('$sellerOrders.items.refundedAmount'),
          },
        },
      },
      {
        $group: {
          _id: { productId: '$sellerOrders.items.productId', variantId: '$sellerOrders.items.variantId' },
          name: { $first: '$sellerOrders.items.name' },
          sku: { $first: '$sellerOrders.items.sku' },
          options: { $first: '$sellerOrders.items.options' },
          orders: { $sum: 1 },
          units: { $sum: '$sellerOrders.items.quantity' },
          grossSales: sumUSD('$li.gross', rc),
          discounts: sumUSD('$li.discounts', rc),
          returns: sumUSD('$li.returns', rc),
        },
      },
      { $sort: { grossSales: -1 } },
      { $limit: 1000 },
    ]);
    return rows.map((r: any) => {
      const grossSales = round(r.grossSales);
      const discounts = round(r.discounts);
      const returns = round(r.returns);
      return {
        productId: r._id.productId,
        variantId: r._id.variantId ?? null,
        name: r.name,
        sku: r.sku ?? null,
        variantTitle: (r.options ?? []).map((o: any) => o.value).filter(Boolean).join(' / ') || null,
        orders: r.orders,
        units: r.units,
        grossSales, discounts, returns,
        netSales: round(grossSales - discounts - returns),
      };
    });
  }

  private async salesByDiscount(scope: Record<string, any>, from: Date, to: Date, rc: ReportingCurrency | null) {
    const base = [
      ...sellerOrderMatchStage(from, to, scope),
      { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $unwind: '$sellerOrders.items' },
    ];
    const lineSales = { $let: { vars: { i: '$sellerOrders.items' }, in: LINE_GROSS } };
    const group = (id: any, amountField: string) => ({
      $group: { _id: id, orders: { $addToSet: '$_id' }, discountAmount: sumUSD(amountField, rc), grossSales: sumUSD('$li', rc) },
    });
    const [codes, automatic, campaigns] = await Promise.all([
      this.r.orderModel.aggregate([...base, { $match: { 'sellerOrders.items.couponDiscountUSD': { $gt: 0 } } }, { $addFields: { li: lineSales } }, group('$couponCode', '$sellerOrders.items.couponDiscountUSD')]),
      this.r.orderModel.aggregate([...base, { $match: { 'sellerOrders.items.autoDiscountUSD': { $gt: 0 } } }, { $addFields: { li: lineSales } }, group('$sellerOrders.items.autoDiscountId', '$sellerOrders.items.autoDiscountUSD')]),
      this.r.orderModel.aggregate([...base, { $match: { 'sellerOrders.items.campaignDiscountUSD': { $gt: 0 } } }, { $addFields: { li: lineSales } }, group('$sellerOrders.items.campaignId', '$sellerOrders.items.campaignDiscountUSD')]),
    ]);
    const names = async (model: any, ids: string[]) => {
      const valid = ids.filter((id) => /^[a-f0-9]{24}$/i.test(String(id)));
      if (!model || !valid.length) return new Map<string, string>();
      const docs = await model.find({ _id: { $in: valid } }).select('name title').lean();
      return new Map<string, string>(docs.map((d: any) => [String(d._id), d.name ?? d.title ?? 'Discount']));
    };
    const [autoNames, campaignNames] = await Promise.all([
      names(this.r.automaticDiscountModel, automatic.map((r: any) => r._id)),
      names(this.r.campaignModel, campaigns.map((r: any) => r._id)),
    ]);
    const row = (type: string, name: string, r: any) => ({
      type, name,
      orders: (r.orders ?? []).length,
      discountAmount: round(r.discountAmount),
      grossSales: round(r.grossSales),
      netSales: round(r.grossSales - r.discountAmount),
    });
    return [
      ...codes.map((r: any) => row('code', r._id ?? 'Discount code', r)),
      ...automatic.map((r: any) => row('automatic', autoNames.get(String(r._id)) ?? 'Automatic discount', r)),
      ...campaigns.map((r: any) => row('campaign', campaignNames.get(String(r._id)) ?? 'Platform campaign', r)),
    ].sort((a, b) => b.discountAmount - a.discountAmount);
  }

  /** Sales channels: Online Store (checkout), Draft orders, Exchanges, and Point of Sale. */
  private async salesByChannel(storeId: string, scope: Record<string, any>, from: Date, to: Date, rc: ReportingCurrency | null) {
    const orderRows = await this.r.orderModel.aggregate([
      ...this.orderStages(scope, from, to),
      {
        $addFields: {
          channel: {
            $cond: [
              { $ne: [{ $ifNull: ['$exchangeOf', null] }, null] }, 'exchange',
              { $cond: [{ $regexMatch: { input: { $ifNull: ['$checkoutId', ''] }, regex: /^draft-/ } }, 'draft_order', 'online_store'] },
            ],
          },
        },
      },
      { $group: AnalyticsReportsService.totalsGroup(rc, '$channel') },
    ]);
    // POS sales live in their own collection, priced in the store currency.
    const [pos] = await this.r.saleModel.aggregate([
      { $match: { storeId, createdAt: { $gte: from, $lte: to }, status: { $in: ['completed', 'partially_refunded', 'refunded'] } } },
      { $group: { _id: null, orders: { $sum: 1 }, gross: { $sum: { $add: [n('$subtotal'), 0] } }, discounts: { $sum: n('$discount') }, returns: { $sum: n('$refundedAmount') }, taxes: { $sum: n('$tax') } } },
    ]);
    const LABELS: Record<string, string> = { online_store: 'Online Store', draft_order: 'Draft orders', exchange: 'Exchanges', pos: 'Point of Sale' };
    const rows = orderRows.map((r: any) => ({ channel: r._id, label: LABELS[r._id] ?? r._id, ...AnalyticsReportsService.finish(r) }));
    if (pos?.orders) {
      rows.push({ channel: 'pos', label: LABELS.pos, ...AnalyticsReportsService.finish({ orders: pos.orders, grossSales: pos.gross, discounts: pos.discounts, returns: pos.returns, shipping: 0, taxes: pos.taxes }) });
    }
    return rows.sort((a: any, b: any) => b.totalSales - a.totalSales);
  }

  // ─── Customer cohort analysis ────────────────────────────────────────────

  /** Monthly cohorts (first-order month) and the % of each cohort that ordered again in each following month. */
  async getCohorts(sellerId: string, storeId: string | null | undefined, query: any) {
    const { scope, tz, currency } = await this.context(sellerId, storeId);
    const months = Math.min(Math.max(Number(query.months) || 12, 3), 24);
    const now = new Date();
    const today = zonedParts(now, tz);
    const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
    // The last `months` calendar months, oldest first, ending with the current (local) month.
    const keys: string[] = [];
    for (let i = 0; i < months; i++) {
      const d = new Date(Date.UTC(today.year, today.month - 1 - (months - 1) + i, 1));
      keys.push(monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1));
    }

    return this.cached(storeId!, 'cohorts', { months, tz, currency, m: keys[keys.length - 1] }, async () => {
      const rows = await this.r.orderModel.aggregate([
        { $match: { isDelete: false, ...(scope['sellerOrders.storeId'] ? { 'sellerOrders.storeId': scope['sellerOrders.storeId'] } : {}) } },
        { $unwind: '$sellerOrders' },
        { $match: { ...scope, 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: { c: { $ifNull: ['$customerId', '$userId'] }, m: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: tz } } } } },
      ]);
      const activity = new Map<string, Set<string>>();
      const first = new Map<string, string>();
      for (const r of rows as any[]) {
        const c = String(r._id.c);
        if (!activity.has(c)) activity.set(c, new Set());
        activity.get(c)!.add(r._id.m);
        if (!first.has(c) || r._id.m < first.get(c)!) first.set(c, r._id.m);
      }
      const index = new Map(keys.map((k, i) => [k, i]));
      const cohorts = keys.map((k) => ({ month: k, customers: 0, retained: Array(keys.length - (index.get(k) ?? 0)).fill(0) as number[] }));
      for (const [c, f] of first) {
        const ci = index.get(f);
        if (ci == null) continue; // first order before the window
        const cohort = cohorts[ci];
        cohort.customers += 1;
        for (const m of activity.get(c)!) {
          const mi = index.get(m);
          if (mi != null && mi > ci) cohort.retained[mi - ci] += 1;
        }
      }
      return {
        success: true,
        data: {
          months,
          cohorts: cohorts.map((c) => ({
            month: c.month,
            customers: c.customers,
            // retention[0] = 100% (the cohort itself); retention[n] = % who ordered again n months later.
            retention: c.retained.map((v, i) => (i === 0 ? (c.customers > 0 ? 100 : 0) : c.customers > 0 ? round((v / c.customers) * 100) : 0)),
          })),
        },
      };
    });
  }

  // ─── Inventory ABC analysis + days of inventory remaining ────────────────

  async getInventoryAbc(sellerId: string, storeId: string | null | undefined) {
    const { scope, rc, tz, currency } = await this.context(sellerId, storeId);
    const now = new Date();
    const from90 = zonedStartOfDay(now, tz, -89);
    const from30 = zonedStartOfDay(now, tz, -29);

    return this.cached(storeId!, 'inventory-abc', { tz, currency, d: localDateKey(now, tz) }, async () => {
      const products: any[] = await this.r.productModel.find({ storeId, isDelete: false }).select('name').lean();
      const productIds = products.map((p) => String(p._id));
      const productName = new Map(products.map((p) => [String(p._id), p.name]));
      const [variants, sales] = await Promise.all([
        this.r.productVariantModel.find({ productId: { $in: productIds }, isDelete: false })
          .select('productId sku options stock committedStock damagedStock inTransitStock unlimitedStock').lean(),
        this.r.orderModel.aggregate([
          ...sellerOrderMatchStage(from90, now, scope),
          { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
          { $unwind: '$sellerOrders.items' },
          { $addFields: { li: { $let: { vars: { i: '$sellerOrders.items' }, in: { $subtract: [n('$$i.totalPrice'), n('$$i.refundedAmount')] } } } } },
          {
            $group: {
              _id: '$sellerOrders.items.variantId',
              revenue: sumUSD('$li', rc),
              units90: { $sum: '$sellerOrders.items.quantity' },
              units30: { $sum: { $cond: [{ $gte: ['$createdAt', from30] }, '$sellerOrders.items.quantity', 0] } },
            },
          },
        ]),
      ]);
      const salesByVariant = new Map<string, any>(sales.map((s: any) => [String(s._id), s]));
      const rows = (variants as any[]).map((v) => {
        const s = salesByVariant.get(String(v._id));
        const units30 = s?.units30 ?? 0;
        const available = v.unlimitedStock ? null : availableStock(v);
        const perDay = units30 / 30;
        return {
          productId: v.productId,
          variantId: String(v._id),
          name: productName.get(v.productId) ?? 'Product',
          variantTitle: (v.options ?? []).map((o: any) => o.value).filter(Boolean).join(' / ') || null,
          sku: v.sku ?? null,
          revenue90: round(s?.revenue ?? 0),
          unitsSold90: s?.units90 ?? 0,
          available,
          // Shopify "Days of inventory remaining" at the last 30 days' pace; null = no recent sales (or unlimited stock).
          daysOfInventory: available == null || perDay <= 0 ? null : round(Math.max(0, available) / perDay),
          grade: 'C' as 'A' | 'B' | 'C',
        };
      }).sort((a, b) => b.revenue90 - a.revenue90);

      // ABC: A = products making the first 80% of revenue, B = the next 15%, C = the rest (incl. no sales).
      const total = rows.reduce((s, r) => s + r.revenue90, 0);
      let running = 0;
      for (const r of rows) {
        if (r.revenue90 <= 0 || total <= 0) { r.grade = 'C'; continue; }
        const before = running / total;
        running += r.revenue90;
        r.grade = before < 0.8 ? 'A' : before < 0.95 ? 'B' : 'C';
      }
      const summary = (g: 'A' | 'B' | 'C') => {
        const list = rows.filter((r) => r.grade === g);
        const revenue = list.reduce((s, r) => s + r.revenue90, 0);
        return { variants: list.length, revenue: round(revenue), revenueShare: total > 0 ? round((revenue / total) * 100) : 0 };
      };
      return {
        success: true,
        data: {
          currency,
          window: { from: from90, to: now },
          summary: { A: summary('A'), B: summary('B'), C: summary('C') },
          rows: rows.slice(0, 1000),
        },
      };
    });
  }

  // ─── CSV export ──────────────────────────────────────────────────────────

  async exportCsv(sellerId: string, storeId: string | null | undefined, query: any): Promise<string> {
    const section = String(query.section);
    const money = (v: number) => Number(v ?? 0).toFixed(2);
    if (section === 'sales-summary') {
      const { data } = await this.getSalesSummary(sellerId, storeId, query);
      const tz = (await this.context(sellerId, storeId)).tz;
      return toCsv(
        ['Date', 'Orders', `Gross sales (${data.currency})`, 'Discounts', 'Returns', 'Net sales', 'Shipping', 'Taxes', 'Total sales'],
        data.series.map((s: any) => [localDateKey(new Date(s.date), tz), s.orders, money(s.grossSales), money(s.discounts), money(s.returns), money(s.netSales), money(s.shipping), money(s.taxes), money(s.totalSales)]),
      );
    }
    if (section === 'cohorts') {
      const { data } = await this.getCohorts(sellerId, storeId, query);
      const width = data.months;
      return toCsv(
        ['Cohort (first order month)', 'Customers', ...Array.from({ length: width }, (_, i) => `Month ${i}`)],
        data.cohorts.map((c: any) => [c.month, c.customers, ...Array.from({ length: width }, (_, i) => (c.retention[i] == null ? '' : `${c.retention[i]}%`))]),
      );
    }
    if (section === 'inventory-abc') {
      const { data } = await this.getInventoryAbc(sellerId, storeId);
      return toCsv(
        ['Grade', 'Product', 'Variant', 'SKU', `Net sales 90 days (${data.currency})`, 'Units sold 90 days', 'Available', 'Days of inventory'],
        data.rows.map((r: any) => [r.grade, r.name, r.variantTitle ?? '', r.sku ?? '', money(r.revenue90), r.unitsSold90, r.available ?? 'Unlimited', r.daysOfInventory ?? '']),
      );
    }
    const dimension = section.replace('sales-by-', '');
    const { data } = await this.getSalesBy(sellerId, storeId, { ...query, dimension });
    if (dimension === 'variant') {
      return toCsv(
        ['Product', 'Variant', 'SKU', 'Orders', 'Units', `Gross sales (${data.currency})`, 'Discounts', 'Returns', 'Net sales'],
        data.rows.map((r: any) => [r.name, r.variantTitle ?? '', r.sku ?? '', r.orders, r.units, money(r.grossSales), money(r.discounts), money(r.returns), money(r.netSales)]),
      );
    }
    if (dimension === 'discount') {
      return toCsv(
        ['Discount', 'Type', 'Orders', `Discount amount (${data.currency})`, 'Gross sales', 'Net sales'],
        data.rows.map((r: any) => [r.name, r.type, r.orders, money(r.discountAmount), money(r.grossSales), money(r.netSales)]),
      );
    }
    return toCsv(
      ['Channel', 'Orders', `Gross sales (${data.currency})`, 'Discounts', 'Returns', 'Net sales', 'Shipping', 'Taxes', 'Total sales'],
      data.rows.map((r: any) => [r.label, r.orders, money(r.grossSales), money(r.discounts), money(r.returns), money(r.netSales), money(r.shipping), money(r.taxes), money(r.totalSales)]),
    );
  }
}
