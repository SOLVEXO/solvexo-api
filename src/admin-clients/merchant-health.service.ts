/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { itemRefundSumField, saleSubtotalExpr, sumUSD } from '../analytics/utils/order-aggregation.util';
import { sellableStockByProduct } from '../analytics/utils/product-stock.util';
import { type HealthBand, type HealthResult, scoreMerchant } from './merchant-health.util';

const DAY = 86_400_000;
const CACHE_MS = 5 * 60_000;

export interface MerchantHealthRow extends HealthResult {
  storeId: string; storeName: string; storeSlug: string | null; storeStatus: string; storeCreatedAt: Date;
  sellerId: string; sellerName: string | null; sellerEmail: string | null;
  planStatus: string | null; lastOrderAt: Date | null; lastSellerLoginAt: Date | null;
  activeProducts: number; revenueLast30: number;
}

export interface MerchantHealthQuery { band?: HealthBand | 'all'; search?: string; sort?: 'score' | 'mrr' | 'name'; order?: 'asc' | 'desc'; page?: number; limit?: number }

/**
 * Health score of every store (see merchant-health.util.ts for the rules). Reads orders, seller sign-ins from the
 * activity log, products and plan subscriptions in a handful of platform-wide queries, then scores in memory.
 * The full list is kept for 5 minutes so paging, filtering and export don't recompute it.
 */
@Injectable()
export class MerchantHealthService {
  private cache: { at: number; rows: MerchantHealthRow[] } | null = null;

  constructor(private readonly db: DatabaseService) {}

  private get r() { return this.db.repositories; }

  async list(q: MerchantHealthQuery, now = Date.now()) {
    const all = await this.allRows(now);
    const filtered = this.filterSort(all, q);
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
    const page = Math.max(Number(q.page) || 1, 1);

    const live = all.filter((row) => row.storeStatus !== 'rejected');
    const sum = (rows: MerchantHealthRow[]) => Math.round(rows.reduce((s, row) => s + row.mrr, 0) * 100) / 100;
    const inBand = (b: HealthBand) => live.filter((row) => row.band === b);
    return {
      success: true,
      data: {
        summary: {
          stores: live.length,
          averageScore: live.length ? Math.round(live.reduce((s, row) => s + row.score, 0) / live.length) : null,
          healthy: inBand('healthy').length, attention: inBand('attention').length, atRisk: inBand('at_risk').length,
          mrrAtRisk: sum(inBand('at_risk')), mrrNeedsAttention: sum(inBand('attention')),
        },
        total: filtered.length, page, limit,
        items: filtered.slice((page - 1) * limit, page * limit),
        computedAt: new Date(this.cache?.at ?? now).toISOString(),
      },
    };
  }

  /** The same filter and order as the list, every row. */
  async exportCsv(q: MerchantHealthQuery): Promise<string> {
    const rows = this.filterSort(await this.allRows(), q);
    const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const day = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const head = ['store', 'seller', 'email', 'score', 'band', 'mrr_usd', 'plan_status', 'last_order', 'last_seller_login', 'active_products', 'revenue_last_30_usd', 'reasons'];
    const lines = rows.map((row) => [
      row.storeName, row.sellerName, row.sellerEmail, row.score, row.band, row.mrr, row.planStatus, day(row.lastOrderAt), day(row.lastSellerLoginAt),
      row.activeProducts, row.revenueLast30, row.reasons.map((x) => x.text).join('; '),
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
  }

  private filterSort(all: MerchantHealthRow[], q: MerchantHealthQuery) {
    const search = (q.search ?? '').trim().toLowerCase();
    const rows = all.filter((row) => (!q.band || q.band === 'all' || row.band === q.band)
      && (!search || [row.storeName, row.storeSlug, row.sellerName, row.sellerEmail].some((v) => v?.toLowerCase().includes(search))));
    // Default: lowest score first; ties go to the store paying the most, since it has the most to lose.
    const dir = q.order === 'desc' ? -1 : 1;
    const sort = q.sort ?? 'score';
    return rows.sort((a, b) => dir * (sort === 'mrr' ? a.mrr - b.mrr : sort === 'name' ? a.storeName.localeCompare(b.storeName) : a.score - b.score)
      || b.mrr - a.mrr);
  }

  /** One store's score with its full breakdown (for the client workspace). */
  async forStore(storeId: string) {
    const row = (await this.allRows()).find((x) => x.storeId === String(storeId)) ?? null;
    return { success: true, data: row };
  }

  private async allRows(now = Date.now()): Promise<MerchantHealthRow[]> {
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.rows;
    const rows = await this.compute(now);
    this.cache = { at: now, rows };
    return rows;
  }

  private async compute(now: number): Promise<MerchantHealthRow[]> {
    const d30 = new Date(now - 30 * DAY), d60 = new Date(now - 60 * DAY), d90 = new Date(now - 90 * DAY);
    const stores: any[] = await this.r.storeModel.find({ isDelete: false }).select('name slug sellerId status createdAt').lean();
    if (stores.length === 0) return [];
    const storeIds = stores.map((s) => String(s._id));

    const [sellers, subs, lastOrders, recentSales, logins, products] = await Promise.all([
      this.r.sellerModel.find({ _id: { $in: [...new Set(stores.map((s) => s.sellerId))] } }).select('name email').lean() as Promise<any[]>,
      this.r.sellerPlatformSubscriptionModel.find({ storeId: { $in: storeIds }, isDelete: { $ne: true } })
        .select('storeId status amountUSD billingInterval cancelAtPeriodEnd failedPaymentAttempts trialEndsAt platformPlanId').lean() as Promise<any[]>,
      this.r.orderModel.aggregate([
        { $match: { isDelete: false } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $group: { _id: '$sellerOrders.storeId', lastOrderAt: { $max: '$createdAt' } } },
      ]),
      this.r.orderModel.aggregate([
        { $match: { isDelete: false, createdAt: { $gte: d90 } } },
        { $unwind: '$sellerOrders' },
        { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
        { $addFields: { itemRefund: itemRefundSumField() } },
        {
          $group: {
            _id: '$sellerOrders.storeId',
            rev30: sumUSD({ $cond: [{ $gte: ['$createdAt', d30] }, saleSubtotalExpr(), 0] }),
            prev30: sumUSD({ $cond: [{ $and: [{ $gte: ['$createdAt', d60] }, { $lt: ['$createdAt', d30] }] }, saleSubtotalExpr(), 0] }),
            gross90: sumUSD(saleSubtotalExpr()),
            refunded90: sumUSD('$itemRefund'),
          },
        },
      ]),
      this.r.activityLogModel.aggregate([
        { $match: { storeId: { $in: storeIds }, category: 'security', action: 'login_success', createdAt: { $gte: d90 } } },
        { $group: { _id: '$storeId', at: { $max: '$createdAt' } } },
      ]),
      this.r.productModel.find({ storeId: { $in: storeIds }, isDelete: false, status: 'active' }).select('storeId').lean() as Promise<any[]>,
    ]);

    const stock = await sellableStockByProduct(this.r.productVariantModel, products.map((p) => String(p._id)));
    const catalog = new Map<string, { active: number; oos: number }>();
    for (const p of products) {
      const c = catalog.get(String(p.storeId)) ?? { active: 0, oos: 0 };
      c.active++;
      const s = stock.get(String(p._id));
      if (s && !s.unlimited && (s.available ?? 0) <= 0) c.oos++;
      catalog.set(String(p.storeId), c);
    }

    const byId = <T>(rows: any[], key = '_id') => new Map<string, T>(rows.map((x) => [String(x[key]), x]));
    const sellerMap = byId<any>(sellers), subMap = byId<any>(subs, 'storeId'), lastMap = byId<any>(lastOrders);
    const salesMap = byId<any>(recentSales), loginMap = byId<any>(logins);
    const round2 = (n: number) => Math.round(n * 100) / 100;

    return stores.map((st) => {
      const id = String(st._id);
      const sale = salesMap.get(id);
      const sub = subMap.get(id) ?? null;
      const cat = catalog.get(id) ?? { active: 0, oos: 0 };
      const seller = sellerMap.get(String(st.sellerId));
      const lastOrderAt = lastMap.get(id)?.lastOrderAt ?? null;
      const lastSellerLoginAt = loginMap.get(id)?.at ?? null;
      const gross90 = sale?.gross90 ?? 0;
      const result = scoreMerchant({
        storeCreatedAt: st.createdAt, lastOrderAt,
        revenueLast30: sale?.rev30 ?? 0, revenuePrev30: sale?.prev30 ?? 0,
        refundRatePercent90: gross90 > 0 ? ((sale?.refunded90 ?? 0) / gross90) * 100 : null,
        lastSellerLoginAt, activeProducts: cat.active, outOfStockProducts: cat.oos, subscription: sub,
      }, now);
      return {
        ...result,
        storeId: id, storeName: st.name ?? 'Unnamed store', storeSlug: st.slug ?? null, storeStatus: st.status ?? 'active', storeCreatedAt: st.createdAt,
        sellerId: String(st.sellerId), sellerName: seller?.name ?? null, sellerEmail: seller?.email ?? null,
        planStatus: sub?.status ?? null, lastOrderAt, lastSellerLoginAt, activeProducts: cat.active, revenueLast30: round2(sale?.rev30 ?? 0),
      };
    });
  }
}
