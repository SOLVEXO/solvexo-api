/* eslint-disable prettier/prettier */
import { AnalyticsReportsService } from './analytics-reports.service';

const STORE = '64b000000000000000000001';
const SELLER = 'seller-1';

describe('AnalyticsReportsService (Shopify report library)', () => {
  let orderModel: any;
  let saleModel: any;
  let productModel: any;
  let productVariantModel: any;
  let service: AnalyticsReportsService;
  const ctx = { scope: { 'sellerOrders.storeId': STORE }, storeIds: [STORE], store: {}, rc: { code: 'PKR', fallbackRatePerUSD: 280 }, tz: 'Asia/Karachi', currency: 'PKR' };

  beforeEach(() => {
    orderModel = { aggregate: jest.fn().mockResolvedValue([]) };
    saleModel = { aggregate: jest.fn().mockResolvedValue([]) };
    productModel = { find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'p1', name: 'Shirt' }, { _id: 'p2', name: 'Cap' }]) }) }) };
    productVariantModel = { find: jest.fn() };
    const db: any = { repositories: { orderModel, saleModel, productModel, productVariantModel, automaticDiscountModel: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }, campaignModel: null } };
    const analytics: any = { resolveContext: jest.fn().mockResolvedValue(ctx) };
    service = new AnalyticsReportsService(db, { isConnected: false } as any, analytics);
  });

  it('finance summary: gross - discounts - returns = net; + shipping + taxes = total (store currency)', async () => {
    orderModel.aggregate
      .mockResolvedValueOnce([{ totals: [{ orders: 3, grossSales: 1000, discounts: 100, returns: 50, shipping: 200, taxes: 85 }], series: [] }])
      .mockResolvedValueOnce([{ orders: 2, grossSales: 500, discounts: 0, returns: 0, shipping: 100, taxes: 40 }]);
    const res = await service.getSalesSummary(SELLER, STORE, { range: '30d' });
    expect(res.data.currency).toBe('PKR');
    expect(res.data.totals).toEqual({ orders: 3, grossSales: 1000, discounts: 100, returns: 50, netSales: 850, shipping: 200, taxes: 85, totalSales: 1135 });
    expect(res.data.changePercent.grossSales).toBe(100);
    expect(res.data.series.length).toBeGreaterThan(0);
    const pipeline = JSON.stringify(orderModel.aggregate.mock.calls[0][0]);
    expect(pipeline).toContain('"sellerOrders.status":{"$ne":"cancelled"}');
    // Gross adds back discounts AND gift card / store credit (payments, not discounts).
    expect(pipeline).toContain('$$i.giftCardDiscountUSD');
    expect(pipeline).toContain('$$i.storeCreditDiscountUSD');
    expect(pipeline).toContain('"timezone":"Asia/Karachi"');
  });

  it('previous-year comparison shifts the comparison window back one year', async () => {
    orderModel.aggregate.mockResolvedValue([]);
    const res = await service.getSalesSummary(SELLER, STORE, { range: 'custom', from: '2026-03-01', to: '2026-03-31', compareTo: 'previous_year' });
    expect(new Date(res.data.previousPeriod.from).toISOString()).toBe('2025-02-28T19:00:00.000Z');
  });

  it('sales by variant: one row per variant with net sales', async () => {
    orderModel.aggregate.mockResolvedValue([
      { _id: { productId: 'p1', variantId: 'v1' }, name: 'Shirt', sku: 'SH-R-M', options: [{ name: 'Color', value: 'Red' }, { name: 'Size', value: 'M' }], orders: 4, units: 6, grossSales: 600, discounts: 60, returns: 100 },
    ]);
    const res = await service.getSalesBy(SELLER, STORE, { range: '30d', dimension: 'variant' });
    expect(res.data.rows[0]).toMatchObject({ variantId: 'v1', variantTitle: 'Red / M', units: 6, netSales: 440 });
  });

  it('sales by channel: online / draft / exchange from orders plus POS sales', async () => {
    orderModel.aggregate.mockResolvedValue([
      { _id: 'online_store', orders: 10, grossSales: 1000, discounts: 0, returns: 0, shipping: 100, taxes: 0 },
      { _id: 'draft_order', orders: 1, grossSales: 50, discounts: 0, returns: 0, shipping: 0, taxes: 0 },
    ]);
    saleModel.aggregate.mockResolvedValue([{ orders: 3, gross: 300, discounts: 30, returns: 0, taxes: 10 }]);
    const res = await service.getSalesBy(SELLER, STORE, { range: '30d', dimension: 'channel' });
    expect(res.data.rows.map((r: any) => r.label)).toEqual(['Online Store', 'Point of Sale', 'Draft orders']);
    expect(res.data.rows.find((r: any) => r.channel === 'pos').totalSales).toBe(280);
    expect(saleModel.aggregate.mock.calls[0][0][0].$match.storeId).toBe(STORE);
  });

  it('rejects an unknown sales-by dimension and a missing store', async () => {
    await expect(service.getSalesBy(SELLER, STORE, { dimension: 'vendor' })).rejects.toThrow('dimension');
    await expect(service.getSalesSummary(SELLER, undefined, {})).rejects.toThrow('storeId is required');
  });

  it('cohorts: first-order month cohorts with repeat-purchase retention', async () => {
    const months = 3;
    const now = new Date();
    const key = (offset: number) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    orderModel.aggregate.mockResolvedValue([
      { _id: { c: 'a', m: key(-2) } }, { _id: { c: 'a', m: key(-1) } }, // a: cohort -2, back next month
      { _id: { c: 'b', m: key(-2) } }, // b: cohort -2, never back
      { _id: { c: 'c', m: key(-1) } }, // c: cohort -1
      { _id: { c: 'old', m: '2000-01' } }, { _id: { c: 'old', m: key(0) } }, // first order before the window: not a cohort
    ]);
    const res = await service.getCohorts(SELLER, STORE, { months });
    const [first, second, third] = res.data.cohorts;
    expect(first).toEqual({ month: key(-2), customers: 2, retention: [100, 50, 0] });
    expect(second).toEqual({ month: key(-1), customers: 1, retention: [100, 0] });
    expect(third).toEqual({ month: key(0), customers: 0, retention: [0] });
  });

  it('inventory ABC: grades by cumulative 90-day sales and days of inventory at the 30-day pace', async () => {
    productVariantModel.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([
      { _id: 'v1', productId: 'p1', stock: 60, committedStock: 0, damagedStock: 0, inTransitStock: 0, options: [] },
      { _id: 'v2', productId: 'p1', stock: 10, committedStock: 0, damagedStock: 0, inTransitStock: 0, options: [] },
      { _id: 'v3', productId: 'p2', stock: 5, committedStock: 0, damagedStock: 0, inTransitStock: 0, options: [] },
      { _id: 'v4', productId: 'p2', stock: 0, unlimitedStock: true, options: [] },
    ]) }) });
    orderModel.aggregate.mockResolvedValue([
      { _id: 'v1', revenue: 800, units90: 90, units30: 30 },
      { _id: 'v2', revenue: 150, units90: 10, units30: 3 },
      { _id: 'v3', revenue: 50, units90: 2, units30: 0 },
    ]);
    const res = await service.getInventoryAbc(SELLER, STORE);
    const byId = new Map(res.data.rows.map((r: any) => [r.variantId, r]));
    expect(byId.get('v1')).toMatchObject({ grade: 'A', daysOfInventory: 60 });
    expect(byId.get('v2')).toMatchObject({ grade: 'B', daysOfInventory: 100 });
    expect(byId.get('v3')).toMatchObject({ grade: 'C', daysOfInventory: null });
    expect(byId.get('v4')).toMatchObject({ grade: 'C', available: null });
    expect(res.data.summary.A).toEqual({ variants: 1, revenue: 800, revenueShare: 80 });
  });

  it('CSV export of the finance summary uses store-local dates and the store currency', async () => {
    orderModel.aggregate.mockResolvedValue([{ totals: [], series: [] }]);
    const csv = await service.exportCsv(SELLER, STORE, { range: '7d', section: 'sales-summary' });
    expect(csv.split('\n')[0]).toContain('Gross sales (PKR)');
    expect(csv.split('\n').length).toBeGreaterThan(7);
  });
});
