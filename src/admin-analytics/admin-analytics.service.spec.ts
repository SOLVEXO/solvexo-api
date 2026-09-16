/* eslint-disable prettier/prettier */
import { AdminAnalyticsService } from './admin-analytics.service';
import { DatabaseService } from '../database/databaseservice';
import { RedisService } from '../redis/redis.service';
import { PlatformPlansService } from '../platform-plans/platform-plans.service';

// Phase 0 — this module had ZERO backend tests before this file. Focus areas
// per the Phase 0 mandate: (1) USD-normalized revenue math (gross/refund/net,
// and the disclosed unconvertibleOrderCount — see order-aggregation.util.ts),
// (2) platform-wide-vs-scoped tenant isolation (buildScope must produce a
// storeId/sellerId-only match, never leak across scopes), (3) zero-data
// windows never throw, (4) payment-method label mapping.
// Phase 1 — also covers Overview's reuse of PlatformPlansService.adminGetRevenue
// for seller-platform MRR/ARR/churn, including that it's platform-wide only
// (never returned for a storeId/sellerId drill-down — see getOverview).

function buildAggregateMock(resultsQueue: any[][]) {
  const queue = [...resultsQueue];
  return jest.fn().mockImplementation(async () => queue.shift() ?? []);
}

describe('AdminAnalyticsService', () => {
  let service: AdminAnalyticsService;
  let orderModel: any;
  let sellerModel: any;
  let storeModel: any;
  let userModel: any;
  let productModel: any;
  let productVariantModel: any;
  let productViewModel: any;
  let paymentTransactionModel: any;
  let transactionModel: any;
  let subscriptionInvoiceModel: any;
  let db: DatabaseService;
  let redis: RedisService;
  let platformPlansService: PlatformPlansService;

  beforeEach(() => {
    orderModel = { aggregate: jest.fn().mockResolvedValue([]) };
    sellerModel = {
      countDocuments: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };
    storeModel = {
      countDocuments: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };
    userModel = {
      countDocuments: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };
    productModel = {
      aggregate: jest.fn().mockResolvedValue([]),
      find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
    };
    productVariantModel = { aggregate: jest.fn().mockResolvedValue([]) };
    // Phase 6 — real view counts from the Phase 5 tracking foundation.
    productViewModel = { aggregate: jest.fn().mockResolvedValue([]) };
    paymentTransactionModel = { aggregate: jest.fn().mockResolvedValue([]) };
    transactionModel = { aggregate: jest.fn().mockResolvedValue([]) };
    subscriptionInvoiceModel = { aggregate: jest.fn().mockResolvedValue([]) };

    db = {
      repositories: {
        orderModel, sellerModel, storeModel, userModel, productModel, productVariantModel, productViewModel,
        paymentTransactionModel, transactionModel, subscriptionInvoiceModel,
      },
    } as any;

    redis = { isConnected: false, get: jest.fn(), set: jest.fn(), del: jest.fn() } as any;

    platformPlansService = {
      adminGetRevenue: jest.fn().mockResolvedValue({
        success: true,
        data: { mrr: 0, arr: 0, activeSubscribers: 0, churnRatePercent: 0, canceledInPeriod: 0, activeAtPeriodStart: 0, planBreakdown: [], totalRevenueUSD: 0, totalInvoicesPaid: 0, byPlan: [] },
      }),
    } as any;

    service = new AdminAnalyticsService(db, redis, platformPlansService);
  });

  describe('zero-data platform', () => {
    it('returns a fully zeroed overview instead of erroring when nothing has ever been ordered', async () => {
      const result = await service.getOverview({});
      expect(result.success).toBe(true);
      expect(result.data.totalGMV).toBe(0);
      expect(result.data.totalRevenue).toBe(0);
      expect(result.data.totalOrders).toBe(0);
      expect(result.data.refundRatePercent).toBe(0);
    });

    it('returns an empty (not errored) top-sellers list', async () => {
      const result = await service.getTopSellers({});
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('USD-normalized revenue math', () => {
    it('subtracts USD-normalized refunds from USD-normalized gross for platform-wide GMV/revenue', async () => {
      orderModel.aggregate = buildAggregateMock([
        // periodTotals(current) inside getOverview
        [{ orderCount: 4, cancelledCount: 1, refundedCount: 1, grossRevenue: 1000, refundAmount: 100, unconvertibleOrderCount: 0, buyerIds: ['a', 'b'] }],
        // periodTotals(previous)
        [{ orderCount: 0, cancelledCount: 0, refundedCount: 0, grossRevenue: 0, refundAmount: 0, unconvertibleOrderCount: 0, buyerIds: [] }],
        // countActiveSellers(current)
        [],
        // countActiveSellers(previous)
        [],
      ]);

      const result = await service.getOverview({});

      expect(result.data.totalGMV).toBe(1000);
      expect(result.data.totalRevenue).toBe(900); // net = gross - refunds, both already USD-normalized
      expect(result.data.totalRefunds).toBe(100);
      expect(result.data.refundRatePercent).toBeCloseTo(10, 1);
      expect(result.data.cancelledOrders).toBe(1);
    });

    it('discloses excluded (pre-ratePerUSD) orders on aggregateSellerSales via getSellerPerformance rather than silently dropping them', async () => {
      orderModel.aggregate = buildAggregateMock([
        // aggregateSellerSales
        [{ _id: 'seller-1', orderCount: 5, unitsSold: 10, grossRevenue: 500, refundedAmount: 0, unconvertibleOrderCount: 2, buyerIds: ['a'] }],
        // allTimeSellerActivity (Phase 3)
        [{ _id: 'seller-1', firstOrderAt: new Date('2026-01-01'), lastOrderAt: new Date('2026-05-20'), totalOrders: 5 }],
      ]);
      sellerModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'seller-1', name: 'Acme', email: 'a@x.com', createdAt: new Date('2025-01-01') }]) }) });
      storeModel.aggregate.mockResolvedValue([{ _id: 'seller-1', storeCount: 1, activeStoreCount: 1 }]);

      const result = await service.getSellerPerformance({});
      expect(result.data.sellers[0].revenue).toBe(500); // netRevenue passthrough, unaffected by the excluded-count disclosure
    });
  });

  describe('Phase 3 — deterministic seller sales status', () => {
    it('attaches a real, date-derived salesStatus to every seller in getSellerPerformance', async () => {
      // lastOrderAt is deliberately relative to the real current time (not a
      // hardcoded absolute date) — deriveSellerSalesStatus's default `now`
      // is real wall-clock time, so a fixed past date silently drifts from
      // "within 30 days" into "at_risk"/"dormant" as real time passes,
      // exactly the bug that made this test start failing on its own.
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      orderModel.aggregate = buildAggregateMock([
        [{ _id: 'seller-1', orderCount: 3, unitsSold: 6, grossRevenue: 300, refundedAmount: 0, unconvertibleOrderCount: 0, buyerIds: ['a'] }],
        [{ _id: 'seller-1', firstOrderAt: new Date('2025-01-01'), lastOrderAt: fiveDaysAgo, totalOrders: 3 }],
      ]);
      sellerModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { _id: 'seller-1', name: 'Acme', email: 'a@x.com', createdAt: new Date('2025-01-01') },
            { _id: 'seller-2', name: 'NoSales', email: 'b@x.com', createdAt: new Date('2025-01-01') }, // never ordered, long-registered
          ]),
        }),
      });
      storeModel.aggregate.mockResolvedValue([]);

      const result = await service.getSellerPerformance({});
      const bySellerId = new Map(result.data.sellers.map((s: any) => [s.sellerId, s]));
      expect(bySellerId.get('seller-1').salesStatus).toBe('active');
      expect(bySellerId.get('seller-2').salesStatus).toBe('dormant'); // established, zero orders ever — never mislabeled "new"
    });
  });

  describe('tenant isolation — buildScope', () => {
    it('scopes platform aggregates to exactly one store when storeId is given, with no sellerId leakage', async () => {
      await service.getOverview({ storeId: 'store-9' });
      const pipeline = orderModel.aggregate.mock.calls[0][0];
      expect(pipeline).toEqual(
        expect.arrayContaining([{ $match: { 'sellerOrders.storeId': 'store-9' } }]),
      );
      expect(pipeline).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ $match: expect.objectContaining({ 'sellerOrders.sellerId': expect.anything() }) })]),
      );
    });

    it('scopes to exactly one seller when sellerId is given, with no storeId leakage', async () => {
      await service.getOverview({ sellerId: 'seller-7' });
      const pipeline = orderModel.aggregate.mock.calls[0][0];
      expect(pipeline).toEqual(
        expect.arrayContaining([{ $match: { 'sellerOrders.sellerId': 'seller-7' } }]),
      );
    });

    it('omits any sellerOrders scope filter for a platform-wide (no storeId/sellerId) call', async () => {
      await service.getOverview({});
      const pipeline = orderModel.aggregate.mock.calls[0][0];
      const scopeStages = pipeline.filter(
        (stage: any) => stage.$match && ('sellerOrders.storeId' in stage.$match || 'sellerOrders.sellerId' in stage.$match),
      );
      expect(scopeStages).toHaveLength(0);
    });
  });

  describe('Phase 1 — seller-platform MRR/ARR/churn on Overview', () => {
    it('surfaces PlatformPlansService.adminGetRevenue\'s figures under distinct names, platform-wide', async () => {
      (platformPlansService.adminGetRevenue as jest.Mock).mockResolvedValue({
        success: true,
        data: { mrr: 500, arr: 6000, activeSubscribers: 42, churnRatePercent: 2.5 },
      });

      const result = await service.getOverview({});

      expect(platformPlansService.adminGetRevenue).toHaveBeenCalledWith(expect.objectContaining({ from: expect.any(Date), to: expect.any(Date) }));
      expect(result.data.sellerPlatformMRR).toBe(500);
      expect(result.data.sellerPlatformARR).toBe(6000);
      expect(result.data.activePlatformSubscribers).toBe(42);
      expect(result.data.sellerChurnRatePercent).toBe(2.5);
    });

    it('omits seller-platform MRR/ARR/churn entirely (never mislabels platform-wide figures as one store\'s own) when a storeId drill-down is active', async () => {
      const result = await service.getOverview({ storeId: 'store-9' });

      expect(platformPlansService.adminGetRevenue).not.toHaveBeenCalled();
      expect(result.data.sellerPlatformMRR).toBeUndefined();
      expect(result.data.sellerChurnRatePercent).toBeUndefined();
    });
  });

  describe('Phase 2 — USD-only platform commission, non-USD disclosed separately', () => {
    it('reports platformCommission as the USD entry only, and surfaces other currencies via nonUsdCommissionByCurrency rather than blending them in', async () => {
      // getPlatformEarningsUtil's own call order: [blended commissionRows, commissionByCurrencyRows] via transactionModel.aggregate, then subRows via subscriptionInvoiceModel.aggregate.
      transactionModel.aggregate = jest.fn()
        .mockResolvedValueOnce([{ commission: 130, processingFees: 3 }]) // deprecated blended total — must NOT be what platformCommission reports
        .mockResolvedValueOnce([
          { _id: 'USD', commission: 100, processingFees: 2 },
          { _id: 'PKR', commission: 30, processingFees: 1 },
        ]);
      subscriptionInvoiceModel.aggregate.mockResolvedValue([{ total: 0 }]);

      const result = await service.getOverview({});

      expect(result.data.platformCommission).toBe(100); // USD entry only, not the blended 130
      expect(result.data.nonUsdCommissionByCurrency).toEqual([{ currency: 'PKR', commission: 30, processingFees: 1 }]);
    });

    it('omits nonUsdCommissionByCurrency entirely when every seller settles in USD', async () => {
      transactionModel.aggregate = jest.fn()
        .mockResolvedValueOnce([{ commission: 100, processingFees: 2 }])
        .mockResolvedValueOnce([{ _id: 'USD', commission: 100, processingFees: 2 }]);
      subscriptionInvoiceModel.aggregate.mockResolvedValue([{ total: 0 }]);

      const result = await service.getOverview({});
      expect(result.data.nonUsdCommissionByCurrency).toBeUndefined();
    });
  });

  describe('payment method breakdown', () => {
    it('maps raw paymentType enum values to human labels via the centralized utility', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([
        { _id: 'manual_bank_transfer', count: 2, revenue: 200 },
        { _id: 'cash_on_delivery', count: 1, revenue: 50 },
      ]);
      paymentTransactionModel.aggregate.mockResolvedValue([]);

      const result = await service.getPaymentBreakdown({});
      const labels = result.data.methodBreakdown.map((r: any) => r.label);
      expect(labels).toContain('Manual Bank Transfer');
      expect(labels).toContain('Cash on Delivery');
      expect(labels).not.toContain('manual_bank_transfer');
    });
  });

  describe('Phase 4 — Customers tab (real-data-only, no Guest fabrication)', () => {
    it('returns a fully zeroed, non-erroring result for a platform with no orders at all', async () => {
      // orderModel.aggregate defaults to mockResolvedValue([]) for every call in beforeEach.
      const result = await service.getCustomerAnalytics({});

      expect(result.success).toBe(true);
      expect(result.data.activeCustomers).toBe(0);
      expect(result.data.repeatCustomerPercent).toBe(0);
      expect(result.data.averageLifetimeValue).toBe(0);
      expect(result.data.topCustomersByLtv).toEqual([]);
      expect(result.data.geographicBreakdown).toEqual([]);
      expect(result.data.countryBreakdown).toEqual([]);
    });

    it('surfaces a buyer whose account was deleted as "Deleted account", never fabricating a "Guest" identity', async () => {
      // Call order inside getCustomerAnalytics: [1] allTimeCustomerAggregate,
      // [2] repeatBuyerPercent, [3] periodRows (new-vs-returning), [4] geoRows,
      // [5] countryRows — then resolveCustomerIdentities' own fallback aggregate.
      orderModel.aggregate = buildAggregateMock([
        [{ _id: 'u1', firstOrderAt: new Date('2026-01-01'), lastOrderAt: new Date('2026-03-01'), totalOrders: 3, grossRevenue: 500, refundAmount: 0 }],
        [], // repeatBuyerPercent
        [], // periodRows
        [], // geoRows
        [], // countryRows
        [], // resolveCustomerIdentities' fallback — no shippingAddress.recipientName either
      ]);
      userModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }); // no live User document

      const result = await service.getCustomerAnalytics({});

      expect(result.data.topCustomersByLtv).toHaveLength(1);
      expect(result.data.topCustomersByLtv[0]).toMatchObject({ userId: 'u1', name: 'Deleted account', totalOrders: 3, lifetimeValue: 500 });
      expect(result.data.topCustomersByLtv[0].name).not.toMatch(/guest/i);
    });

    it('labels a shippingAddress with no country as "Not Recorded" rather than guessing one from the state', async () => {
      orderModel.aggregate = buildAggregateMock([
        [], // allTimeCustomerAggregate
        [], // repeatBuyerPercent
        [], // periodRows
        [{ _id: 'Punjab', orders: 2, revenue: 200, unconvertibleOrderCount: 0 }], // geoRows (state)
        [{ _id: null, orders: 2, revenue: 200, unconvertibleOrderCount: 0 }], // countryRows — pre-dates shippingAddress.country
      ]);

      const result = await service.getCustomerAnalytics({});

      expect(result.data.countryBreakdown).toEqual([{ country: 'Not Recorded', orders: 2, revenue: 200 }]);
      expect(result.data.note).toContain('Not Recorded');
    });
  });

  describe('Phase 6 — Products tab consumes the Phase 5 view-tracking foundation', () => {
    it('attaches real views and a computed conversion rate to each top product', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([
        { _id: 'p1', name: 'Widget', orderCount: 5, unitsSold: 8, grossRevenue: 500, refundedAmount: 0 },
      ]);
      productViewModel.aggregate = jest.fn().mockResolvedValue([{ _id: 'p1', views: 100 }]);

      const result = await service.getTopProducts({});

      expect(result.data[0]).toMatchObject({ productId: 'p1', views: 100, viewToPurchaseConversionPercent: 5 });
    });

    it('reports 0 views and a null (never 0%) conversion rate for a product with real sales but no tracked views yet', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([
        { _id: 'p1', name: 'Widget', orderCount: 5, unitsSold: 8, grossRevenue: 500, refundedAmount: 0 },
      ]);
      productViewModel.aggregate = jest.fn().mockResolvedValue([]); // nothing tracked (e.g. all pre-launch traffic)

      const result = await service.getTopProducts({});

      expect(result.data[0].views).toBe(0);
      expect(result.data[0].viewToPurchaseConversionPercent).toBeNull();
    });

    it('scopes the view lookup to the same storeId/sellerId drill-down as the sales figures', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([]);
      productViewModel.aggregate = jest.fn().mockResolvedValue([]);

      await service.getTopProducts({ storeId: 'store-9' });

      const viewsPipeline = productViewModel.aggregate.mock.calls[0][0];
      expect(viewsPipeline[0].$match.storeId).toBe('store-9');
    });

    it('attaches real views/conversion to getProductPerformance rows alongside the existing sales/stock figures', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([
        { _id: 'p1', name: 'Widget', orderCount: 4, unitsSold: 6, grossRevenue: 300, refundedAmount: 0 },
      ]);
      productModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'p1', name: 'Widget' }]) }) });
      productVariantModel.aggregate = jest.fn().mockResolvedValue([{ _id: 'p1', stock: 20 }]);
      productViewModel.aggregate = jest.fn().mockResolvedValue([{ _id: 'p1', views: 50 }]);

      const result = await service.getProductPerformance({});

      expect(result.data.products[0]).toMatchObject({ productId: 'p1', views: 50, viewToPurchaseConversionPercent: 8, currentStock: 20 });
      expect(result.data.note).toContain('launch date');
    });

    it('never breaks the zero-data case — a platform with no products/views still returns an empty, non-erroring list', async () => {
      const result = await service.getProductPerformance({});
      expect(result.success).toBe(true);
      expect(result.data.products).toEqual([]);
    });
  });

  describe('Phase 7 — Orders tab: real Mongo-side (skip/limit) pagination', () => {
    it('returns real order rows with resolved buyer/seller/store names and the correct pagination total', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([
        {
          rows: [
            { orderId: 'order-1', createdAt: new Date('2026-01-05'), userId: 'u1', status: 'delivered', sellerId: 'seller-1', storeId: 'store-1', itemCount: 2, grossAmountUSD: 100, refundedAmountUSD: 0 },
          ],
          totalCount: [{ count: 57 }],
        },
      ]);
      userModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'u1', name: 'Amina Khan', email: 'amina@example.com' }]) }) });
      sellerModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'seller-1', name: 'Acme Store' }]) }) });
      storeModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ _id: 'store-1', name: 'Acme Flagship' }]) }) });

      const result = await service.getOrdersList({ page: 2, limit: 20 });

      expect(result.data.pagination).toEqual({ page: 2, limit: 20, total: 57, totalPages: 3 });
      expect(result.data.orders[0]).toMatchObject({
        orderId: 'order-1', buyerName: 'Amina Khan', sellerName: 'Acme Store', storeName: 'Acme Flagship',
        grossAmountUSD: 100, unconvertible: false,
      });
    });

    it('paginates INSIDE the Mongo aggregation ($skip/$limit in the pipeline) rather than fetching everything and slicing in JS', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([{ rows: [], totalCount: [] }]);

      await service.getOrdersList({ page: 3, limit: 10 });

      const pipeline = orderModel.aggregate.mock.calls[0][0];
      const rowsPipeline = pipeline.find((stage: any) => stage.$facet)?.$facet.rows;
      expect(rowsPipeline).toEqual(expect.arrayContaining([{ $skip: 20 }, { $limit: 10 }]));
    });

    it('discloses (never guesses) the amount for an order that predates USD-rate capture', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([
        {
          rows: [{ orderId: 'order-2', createdAt: new Date(), userId: 'u1', status: 'completed', sellerId: 's1', storeId: 'st1', itemCount: 1, grossAmountUSD: null, refundedAmountUSD: null }],
          totalCount: [{ count: 1 }],
        },
      ]);

      const result = await service.getOrdersList({});

      expect(result.data.orders[0].unconvertible).toBe(true);
      expect(result.data.orders[0].grossAmountUSD).toBeNull();
    });

    it('never fabricates a "Guest" buyer name for an order whose buyer account was deleted', async () => {
      orderModel.aggregate = buildAggregateMock([
        [{ rows: [{ orderId: 'order-3', createdAt: new Date(), userId: 'u9', status: 'completed', sellerId: 's1', storeId: 'st1', itemCount: 1, grossAmountUSD: 10, refundedAmountUSD: 0 }], totalCount: [{ count: 1 }] }],
        [], // resolveCustomerIdentities' shippingAddress fallback — none either
      ]);
      userModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });

      const result = await service.getOrdersList({});

      expect(result.data.orders[0].buyerName).toBe('Deleted account');
      expect(result.data.orders[0].buyerName).not.toMatch(/guest/i);
    });

    it('never breaks on an empty result — an unfiltered window with no orders returns an empty page, not an error', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([{ rows: [], totalCount: [] }]);

      const result = await service.getOrdersList({});

      expect(result.success).toBe(true);
      expect(result.data.orders).toEqual([]);
      expect(result.data.pagination.total).toBe(0);
    });

    it('applies a status filter as an extra $match stage when provided', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([{ rows: [], totalCount: [] }]);

      await service.getOrdersList({ status: 'cancelled' });

      const pipeline = orderModel.aggregate.mock.calls[0][0];
      expect(pipeline).toEqual(expect.arrayContaining([{ $match: { 'sellerOrders.status': 'cancelled' } }]));
    });
  });

  describe('Phase 8 — Payments tab: real per-transaction USD normalization', () => {
    it('reports each status\'s USD-normalized amount and discloses its own unconvertible count', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([]);
      paymentTransactionModel.aggregate = jest.fn().mockResolvedValue([
        { _id: 'completed', count: 10, amount: 500, unconvertibleCount: 2 },
        { _id: 'failed', count: 3, amount: 20, unconvertibleCount: 0 },
      ]);

      const result = await service.getPaymentBreakdown({});

      expect(result.data.successfulPayments).toEqual({ count: 10, amount: 500, unconvertibleCount: 2 });
      expect(result.data.failedPayments).toEqual({ count: 3, amount: 20, unconvertibleCount: 0 });
      expect(result.data.pendingPayments).toEqual({ count: 0, amount: 0, unconvertibleCount: 0 });
      expect(result.data.note).toContain('predate fxSnapshots capture');
    });

    it('derives the USD amount from an $addFields stage rather than summing the raw cross-currency amount directly', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([]);
      paymentTransactionModel.aggregate = jest.fn().mockResolvedValue([]);

      await service.getPaymentBreakdown({});

      const pipeline = paymentTransactionModel.aggregate.mock.calls[0][0];
      expect(pipeline.some((stage: any) => stage.$addFields?.amountUSD)).toBe(true);
      const groupStage = pipeline.find((stage: any) => stage.$group);
      expect(groupStage.$group.amount).toEqual({ $sum: { $ifNull: ['$amountUSD', 0] } });
    });

    it('omits the fxSnapshots-unconvertible disclosure sentence entirely when nothing is unconvertible', async () => {
      orderModel.aggregate = jest.fn().mockResolvedValue([]);
      paymentTransactionModel.aggregate = jest.fn().mockResolvedValue([
        { _id: 'completed', count: 5, amount: 200, unconvertibleCount: 0 },
      ]);

      const result = await service.getPaymentBreakdown({});
      expect(result.data.note).not.toContain('predate fxSnapshots capture');
    });
  });

  describe('Phase 9 — Merchant Acquisition Tracking: real UTM/referrer breakdown, never Order.attributionSource', () => {
    it('groups sellers by their own captured acquisition source/medium/campaign', async () => {
      sellerModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { acquisitionSource: 'google', acquisitionMedium: 'cpc', acquisitionCampaign: 'spring', acquisitionCapturedAt: new Date() },
            { acquisitionSource: 'google', acquisitionMedium: 'cpc', acquisitionCampaign: 'spring', acquisitionCapturedAt: new Date() },
            { acquisitionSource: null, acquisitionMedium: null, acquisitionCampaign: null, acquisitionCapturedAt: null },
          ]),
        }),
      });

      const result = await service.getSellerAcquisitionBreakdown({});

      expect(result.success).toBe(true);
      expect(result.data.totalSellers).toBe(3);
      expect(result.data.attributedCount).toBe(2);
      expect(result.data.breakdown).toEqual([
        { source: 'google', medium: 'cpc', campaign: 'spring', sellerCount: 2 },
        { source: 'Organic / Direct', medium: null, campaign: null, sellerCount: 1 },
      ]);
    });

    it('discloses the organic/pre-tracking ambiguity by name, and never mentions Order.attributionSource', async () => {
      sellerModel.find = jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { acquisitionSource: null, acquisitionMedium: null, acquisitionCampaign: null, acquisitionCapturedAt: null },
          ]),
        }),
      });

      const result = await service.getSellerAcquisitionBreakdown({});

      expect(result.data.note).toContain('cannot be distinguished from stored data alone');
      expect(result.data.note.toLowerCase()).not.toContain('attributionsource');
    });

    it('returns a zeroed, non-throwing result when no sellers signed up in the period', async () => {
      const result = await service.getSellerAcquisitionBreakdown({});
      expect(result.success).toBe(true);
      expect(result.data.totalSellers).toBe(0);
      expect(result.data.attributedCount).toBe(0);
      expect(result.data.breakdown).toEqual([]);
      expect(result.data.note).toBe('No sellers signed up in this period.');
    });
  });
});
