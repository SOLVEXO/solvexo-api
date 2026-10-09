/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';

const STORE_ID = '64b000000000000000000001';
const SELLER_ID = 'seller-1';

function buildAggregateMock(resultsQueue: any[][]) {
  const queue = [...resultsQueue];
  return jest.fn().mockImplementation(async () => queue.shift() ?? []);
}

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let orderModel: any;
  let storeModel: any;
  let productModel: any;
  let productVariantModel: any;
  let userModel: any;
  let subscriptionInvoiceModel: any;
  let exchangeRateModel: any;
  let db: DatabaseService;
  let redis: RedisService;

  beforeEach(() => {
    orderModel = { aggregate: jest.fn().mockResolvedValue([]) };
    storeModel = {
      findOne: jest.fn().mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, name: 'Test Store' }),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: STORE_ID, baseCurrency: 'USD' }]) }) }),
    };
    productModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    productVariantModel = { aggregate: jest.fn().mockResolvedValue([]), find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    userModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };
    subscriptionInvoiceModel = { aggregate: jest.fn().mockResolvedValue([]) };
    exchangeRateModel = { findOne: jest.fn().mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve({ ratePerUSD: 280 }) }) }) }) };

    db = {
      repositories: {
        orderModel, storeModel, productModel, productVariantModel, userModel, subscriptionInvoiceModel, exchangeRateModel,
      },
    } as any;

    redis = { isConnected: false, get: jest.fn(), set: jest.fn(), del: jest.fn() } as any;

    service = new AnalyticsService(db, redis);
  });

  describe('ownership', () => {
    it('rejects access when the store does not belong to the requesting seller', async () => {
      storeModel.findOne.mockResolvedValueOnce(null); // simulates no match for {_id, sellerId}

      await expect(service.getOverview(SELLER_ID, STORE_ID, { range: '30d' })).rejects.toThrow(ForbiddenException);
    });

    it('scopes the ownership lookup by both storeId and sellerId, never storeId alone', async () => {
      await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(storeModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false }),
      );
    });
  });

  describe('zero-order store', () => {
    it('returns a fully zeroed overview instead of erroring', async () => {
      orderModel.aggregate.mockResolvedValue([]); // every aggregation call returns no rows

      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });

      expect(result.success).toBe(true);
      expect(result.data.totalRevenue).toBe(0);
      expect(result.data.totalOrders).toBe(0);
      expect(result.data.repeatBuyerPercent).toBe(0);
      expect(result.data.newCustomersCount).toBe(0);
      expect(result.data.refundRatePercent).toBe(0);
    });

    it('returns an empty (not errored) revenue-over-time series, zero-filled across the requested range', async () => {
      orderModel.aggregate.mockResolvedValue([]);

      const result = await service.getRevenueOverTime(SELLER_ID, STORE_ID, { range: '7d' });

      expect(result.success).toBe(true);
      expect(result.data.series.length).toBeGreaterThan(0);
      expect(result.data.series.every((s: any) => s.grossRevenue === 0 && s.netRevenue === 0)).toBe(true);
    });

    it('returns an empty top-products list instead of erroring', async () => {
      orderModel.aggregate.mockResolvedValue([]);
      const result = await service.getTopProducts(SELLER_ID, STORE_ID, { range: '30d' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('net vs gross revenue', () => {
    it('subtracts item-level refunds from gross subtotal to produce net revenue', async () => {
      orderModel.aggregate = buildAggregateMock([
        // periodTotals (current)
        [{ orderCount: 3, cancelledCount: 0, refundedCount: 1, grossRevenue: 300, refundAmount: 50, buyerIds: ['u1', 'u2'] }],
        // periodTotals (previous)
        [{ orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, buyerIds: [] }],
        // repeatBuyerPercent (current)
        [{ totalCustomers: 2, repeatCustomers: 0 }],
        // repeatBuyerPercent (previous)
        [],
        // returningBuyerSet
        [],
      ]);

      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });

      expect(result.data.grossRevenue).toBe(300);
      expect(result.data.totalRevenue).toBe(250); // net = gross - refunds
      expect(result.data.totalRefunds).toBe(50);
      expect(result.data.refundRatePercent).toBeCloseTo((50 / 300) * 100, 1); // service rounds to 2 decimals
    });
  });

  describe('repeat-buyer percent', () => {
    it('computes repeat buyers as a percentage of unique buyers in the period', async () => {
      orderModel.aggregate = buildAggregateMock([
        [{ orderCount: 5, cancelledCount: 0, refundedCount: 0, grossRevenue: 500, refundAmount: 0, buyerIds: ['a', 'b', 'c', 'd'] }],
        [{ orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, buyerIds: [] }],
        [{ totalCustomers: 4, repeatCustomers: 1 }], // 1 of 4 buyers ordered twice+
        [],
        [],
      ]);

      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(result.data.repeatBuyerPercent).toBe(25);
    });
  });

  describe('customer analytics — lifetime value', () => {
    it('computes LTV as net revenue (gross minus refunds) per customer, all-time for the store', async () => {
      orderModel.aggregate = buildAggregateMock([
        // allTimeCustomerAggregate
        [
          { _id: 'u1', firstOrderAt: new Date('2026-01-01'), lastOrderAt: new Date('2026-03-01'), totalOrders: 3, grossRevenue: 300, refundAmount: 20 },
          { _id: 'u2', firstOrderAt: new Date('2026-02-01'), lastOrderAt: new Date('2026-02-01'), totalOrders: 1, grossRevenue: 50, refundAmount: 0 },
        ],
        // periodRows (new vs returning)
        [],
        // geoRows
        [],
      ]);

      const result = await service.getCustomerAnalytics(SELLER_ID, STORE_ID, { range: '90d' });

      expect(result.data.topCustomersByLtv[0].lifetimeValue).toBe(280); // 300 - 20
      expect(result.data.topCustomersByLtv[1].lifetimeValue).toBe(50);
      expect(result.data.averageLifetimeValue).toBe((280 + 50) / 2);
    });
  });

  describe('store currency + store time zone (Shopify reports)', () => {
    const json = (v: any) => JSON.stringify(v);

    it('reports a PKR store in PKR, converting each order at ITS OWN frozen rate (latest rate only as fallback)', async () => {
      storeModel.findOne.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, baseCurrency: 'PKR', country: 'PK' });
      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(result.data.currency).toBe('PKR');
      const pipeline = json(orderModel.aggregate.mock.calls[0][0]);
      expect(pipeline).toContain('"$eq":["$currency","PKR"]'); // a PKR order is used as-is
      expect(pipeline).toContain('"$$s.currency","PKR"'); // else its own fxSnapshots PKR rate
      expect(pipeline).toContain('280'); // latest rate only when the order has no PKR snapshot
    });

    it('a USD store stays on plain USD conversion', async () => {
      storeModel.findOne.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, baseCurrency: 'USD' });
      const result = await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(result.data.currency).toBe('USD');
      expect(exchangeRateModel.findOne).not.toHaveBeenCalled();
    });

    it('buckets charts in the store time zone (country default when none is set)', async () => {
      storeModel.findOne.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, baseCurrency: 'PKR', country: 'PK', timezone: null });
      await service.getRevenueOverTime(SELLER_ID, STORE_ID, { range: '7d' });
      expect(json(orderModel.aggregate.mock.calls[0][0])).toContain('"timezone":"Asia/Karachi"');
      storeModel.findOne.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, baseCurrency: 'USD', country: 'US', timezone: 'America/New_York' });
      await service.getRevenueOverTime(SELLER_ID, STORE_ID, { range: '7d' });
      expect(json(orderModel.aggregate.mock.calls[1][0])).toContain('"timezone":"America/New_York"');
    });

    it('PERFORMANCE: matches the store BEFORE unwinding (uses the sellerOrders.storeId index)', async () => {
      await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      const firstStage = orderModel.aggregate.mock.calls[0][0][0];
      expect(firstStage.$match['sellerOrders.storeId']).toBe(STORE_ID);
    });

    it('REGRESSION: a preset range hits the cache on the second request', async () => {
      const store = new Map<string, string>();
      (redis as any).isConnected = true;
      (redis as any).get = jest.fn(async (k: string) => store.get(k) ?? null);
      (redis as any).set = jest.fn(async (k: string, v: string) => { store.set(k, v); });
      await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      const calls = orderModel.aggregate.mock.calls.length;
      await service.getOverview(SELLER_ID, STORE_ID, { range: '30d' });
      expect(orderModel.aggregate.mock.calls.length).toBe(calls);
    });

    it('rejects a malformed store id with 403 instead of a database cast error', async () => {
      await expect(service.getOverview(SELLER_ID, 'not-an-id', { range: '30d' })).rejects.toThrow(ForbiddenException);
    });

    it('export without a store id is a 400, not a 500', async () => {
      await expect(service.exportCsv(SELLER_ID, undefined, { range: '30d' })).rejects.toThrow('storeId is required');
    });

    it('weekday performance averages over every calendar day (empty days count as zero)', async () => {
      // 14 Mondays with sales, nothing else — only Monday can be busiest; every other weekday averages 0.
      const rows: any[] = [];
      for (let i = 0; i < 14; i++) rows.push({ _id: { day: '2026-01-' + String(i + 1).padStart(2, '0'), weekday: 2 }, netRevenue: 100 });
      orderModel.aggregate.mockResolvedValue(rows);
      const res = await service.getWeekdayPerformance(SELLER_ID, STORE_ID);
      expect(res.data!.busiestDay).toBe('Monday');
      expect(res.data!.slowestDay).not.toBe('Monday');
    });
  });

  describe('online store sessions + live view', () => {
    let storefrontSessionModel: any;
    beforeEach(() => {
      storefrontSessionModel = {
        aggregate: jest.fn(),
        findOne: jest.fn().mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve({ startedAt: new Date('2026-10-01') }) }) }) }),
      };
      (db as any).repositories.storefrontSessionModel = storefrontSessionModel;
    });

    it('computes conversion rate and the cart -> checkout -> converted funnel from sessions', async () => {
      storefrontSessionModel.aggregate
        .mockResolvedValueOnce([{
          totals: [{ sessions: 200, pageViews: 600, bounced: 80, returning: 50, addedToCart: 40, reachedCheckout: 20, converted: 10 }],
          visitors: [{ n: 150 }],
          overTime: [],
          byDevice: [{ _id: 'mobile', sessions: 150, converted: 6 }],
          byCountry: [], bySource: [{ _id: 'search', sessions: 100, converted: 8 }], byReferrer: [], byLandingPage: [],
        }])
        .mockResolvedValueOnce([{ sessions: 100, converted: 2 }]);
      const res = await service.getSessionsReport(SELLER_ID, STORE_ID, { range: '30d' });
      expect(res.data).toMatchObject({
        sessions: 200, sessionsChangePercent: 100, visitors: 150, conversionRate: 5, conversionRateChange: 3,
        bounceRate: 40, pagesPerSession: 3, returningVisitorRate: 25,
        funnel: { addedToCart: 40, addedToCartRate: 20, reachedCheckout: 20, reachedCheckoutRate: 10, converted: 10, conversionRate: 5 },
      });
      expect(res.data.byDevice[0]).toEqual({ deviceType: 'mobile', sessions: 150, conversionRate: 4 });
      expect(res.data.byTrafficSource[0]).toEqual({ source: 'search', sessions: 100, conversionRate: 8 });
      expect(res.data.series.length).toBeGreaterThan(0);
      expect(storefrontSessionModel.aggregate.mock.calls[0][0][0].$match.storeId).toBe(STORE_ID);
    });

    it('live view: visitors in the last 5 minutes, carts, checkouts and today', async () => {
      storefrontSessionModel.aggregate
        .mockResolvedValueOnce([{ counts: [{ visitorsNow: 7, activeCarts: 2, checkingOut: 1, purchased: 1 }], pages: [{ _id: '/', visitors: 4 }], countries: [{ _id: 'PK', visitors: 7 }], devices: [{ _id: 'mobile', visitors: 5 }] }])
        .mockResolvedValueOnce([{ sessions: 40, converted: 2 }]);
      const res = await service.getLiveView(SELLER_ID, STORE_ID);
      expect(res.data).toMatchObject({ visitorsNow: 7, activeCarts: 2, checkingOut: 1, purchasedNow: 1, today: { sessions: 40, conversionRate: 5 } });
      expect(res.data.topPages[0]).toEqual({ path: '/', visitors: 4 });
    });

    it('sessions report requires a store', async () => {
      await expect(service.getSessionsReport(SELLER_ID, undefined, { range: '30d' })).rejects.toThrow('storeId is required');
    });
  });
});
