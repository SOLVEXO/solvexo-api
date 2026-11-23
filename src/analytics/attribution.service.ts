/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/databaseservice';
import { AnalyticsService } from './analytics.service';
import { resolveDateRange } from './utils/analytics-date.util';
import { saleSubtotalExpr, sellerOrderMatchStage, sumUSD } from './utils/order-aggregation.util';
import {
  AttributionDimension,
  AttributionModel,
  LOOKBACK_DAYS,
  Touch,
  buildRows,
  dimensionKey,
  isAttributionDimension,
  isAttributionModel,
  pickTouch,
} from './utils/attribution.util';

const MAX_ORDERS = 20_000;
const DAY_MS = 86_400_000;
/** These channels are not marketing: nobody (or nothing we can tell) sent the customer. */
const NOT_MARKETING = new Set(['direct', 'unattributed']);

/**
 * Shopify's Growth → Overview / Attribution / Campaigns numbers for one store: sessions, orders and sales credited to a
 * marketing channel, source or campaign, with a choice of attribution model (see attribution.util). Sales are the store's
 * reporting-currency sale subtotals of its non-cancelled orders — the same figure the rest of Analytics uses.
 */
@Injectable()
export class AttributionService {
  constructor(private readonly databaseService: DatabaseService, private readonly analytics: AnalyticsService) {}

  private get r() { return this.databaseService.repositories; }

  async getAttribution(sellerId: string, storeId: string | undefined, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');
    const { scope, rc, tz, currency } = await this.analytics.resolveContext(sellerId, storeId);
    const { from, to } = resolveDateRange(query, tz);
    const model: AttributionModel = isAttributionModel(query.model) ? query.model : 'last_non_direct';
    const by: AttributionDimension = isAttributionDimension(query.by) ? query.by : 'channel';

    // 1. The store's orders in the range (one row per order) with their sale value.
    const orders: { _id: any; revenue: number; at: Date }[] = await this.r.orderModel.aggregate([
      ...sellerOrderMatchStage(from, to, scope),
      { $match: { 'sellerOrders.status': { $ne: 'cancelled' } } },
      { $group: { _id: '$_id', revenue: sumUSD(saleSubtotalExpr(), rc), at: { $first: '$createdAt' } } },
      { $limit: MAX_ORDERS },
    ]);
    const orderIds = orders.map((o) => String(o._id));

    // 2. The visit each order converted in, and (for the history-based models) the same customers' other visits.
    const select = 'sessionId visitorId startedAt trafficSource utmSource utmMedium utmCampaign referrerHost orderIds';
    const converting: any[] = orderIds.length
      ? await this.r.storefrontSessionModel.find({ storeId, converted: true, orderIds: { $in: orderIds } }).select(select).lean()
      : [];
    const sessionByOrder = new Map<string, Touch>();
    for (const s of converting) for (const id of s.orderIds ?? []) sessionByOrder.set(String(id), s as Touch);

    const visitorTouches = new Map<string, Touch[]>();
    if (model !== 'last_click' && converting.length) {
      const visitors = [...new Set(converting.map((s) => s.visitorId))];
      const history: any[] = await this.r.storefrontSessionModel
        .find({ storeId, visitorId: { $in: visitors }, startedAt: { $gte: new Date(from.getTime() - LOOKBACK_DAYS * DAY_MS), $lte: to } })
        .select(select)
        .limit(200_000)
        .lean();
      for (const h of history) {
        const list = visitorTouches.get(h.visitorId) ?? [];
        list.push(h as Touch);
        visitorTouches.set(h.visitorId, list);
      }
    }

    // 3. Credit each order to one touch, then to a row of the chosen dimension.
    const credited: { key: string; sales: number }[] = [];
    let totalSales = 0;
    for (const o of orders) {
      const revenue = Number(o.revenue) || 0;
      totalSales += revenue;
      const conv = sessionByOrder.get(String(o._id));
      let key: string | null;
      if (!conv) key = by === 'campaign' ? null : 'unattributed';
      else {
        const touch = pickTouch(model, conv, visitorTouches.get(conv.visitorId) ?? [conv], new Date(o.at));
        key = dimensionKey(by, touch);
      }
      if (key) credited.push({ key, sales: revenue });
    }

    // 4. Sessions per row (all visits in the range, by the visit's own source).
    const keyExpr: any = by === 'channel'
      ? '$trafficSource'
      : by === 'source'
        ? { $toLower: { $ifNull: ['$utmSource', { $ifNull: ['$referrerHost', '$trafficSource'] }] } }
        : { $toLower: '$utmCampaign' };
    const sessionRows: { _id: string; n: number }[] = await this.r.storefrontSessionModel.aggregate([
      { $match: { storeId, startedAt: { $gte: from, $lte: to }, ...(by === 'campaign' ? { utmCampaign: { $nin: [null, ''] } } : {}) } },
      { $group: { _id: keyExpr, n: { $sum: 1 } } },
    ]);
    const sessionCounts = new Map<string, number>(sessionRows.filter((r) => r._id).map((r) => [String(r._id), r.n]));
    const totalSessions = await this.r.storefrontSessionModel.countDocuments({ storeId, startedAt: { $gte: from, $lte: to } });

    const rows = buildRows(sessionCounts, credited);
    const marketingSales = by === 'channel'
      ? rows.filter((r) => !NOT_MARKETING.has(r.key)).reduce((s, r) => s + r.sales, 0)
      : null;
    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
      success: true,
      data: {
        model,
        by,
        currency,
        range: { from, to },
        lookbackDays: LOOKBACK_DAYS,
        rows,
        totals: {
          sessions: totalSessions,
          orders: orders.length,
          sales: round2(totalSales),
          averageOrderValue: orders.length ? round2(totalSales / orders.length) : 0,
          conversionRate: totalSessions ? round2((orders.length / totalSessions) * 100) : 0,
          marketingSales: marketingSales === null ? null : round2(marketingSales),
        },
      },
    };
  }

  /** Growth → Campaigns: every saved campaign with the sessions / orders / sales its UTM tag brought in. */
  async getCampaignsReport(sellerId: string, storeId: string | undefined, query: any) {
    const report = await this.getAttribution(sellerId, storeId, { ...query, by: 'campaign' });
    const campaigns: any[] = await this.r.marketingCampaignModel.find({ storeId, isDelete: false }).sort({ createdAt: -1 }).limit(500).lean();
    const byTag = new Map(report.data.rows.map((r) => [r.key, r]));
    const rows = campaigns.map((c) => {
      const stats = byTag.get(String(c.utmCampaign).toLowerCase());
      return {
        _id: String(c._id),
        name: c.name,
        channel: c.channel,
        status: c.status,
        utmCampaign: c.utmCampaign,
        utmSource: c.utmSource ?? null,
        utmMedium: c.utmMedium ?? null,
        createdAt: c.createdAt,
        sessions: stats?.sessions ?? 0,
        orders: stats?.orders ?? 0,
        sales: stats?.sales ?? 0,
        averageOrderValue: stats?.averageOrderValue ?? 0,
        conversionRate: stats?.conversionRate ?? 0,
      };
    });
    // UTM campaign names that brought visits but are not saved as a campaign yet.
    const known = new Set(campaigns.map((c) => String(c.utmCampaign).toLowerCase()));
    const untracked = report.data.rows.filter((r) => !known.has(r.key));
    return { success: true, data: { model: report.data.model, currency: report.data.currency, range: report.data.range, campaigns: rows, untracked } };
  }

  /** Growth → Overview: marketing-attributed sales, the top channels, and the latest campaigns. */
  async getOverview(sellerId: string, storeId: string | undefined, query: any) {
    const channels = await this.getAttribution(sellerId, storeId, { ...query, by: 'channel' });
    const campaigns = await this.getCampaignsReport(sellerId, storeId, query);
    return {
      success: true,
      data: {
        model: channels.data.model,
        currency: channels.data.currency,
        range: channels.data.range,
        totals: channels.data.totals,
        topChannels: channels.data.rows.slice(0, 6),
        recentCampaigns: campaigns.data.campaigns.slice(0, 5),
      },
    };
  }
}
