/* eslint-disable */
// Runs EVERY seller analytics method (all tabs) with the real services + real schemas against a throw-away Mongo
// holding clean AND dirty orders (money stored as text, nulls, zero rate, no items...).
// Usage: ANALYTICS_IT_MONGO=mongodb://127.0.0.1:27096 npx ts-node -r tsconfig-paths/register scripts/analytics-dirty-data-check.ts
import mongoose from 'mongoose';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { AnalyticsReportsService } from '../src/analytics/analytics-reports.service';
import { OrderSchema } from '../src/orders/schemas/order.schema';
import { StoreSchema } from '../src/store/schemas/store.schema';
import { ProductSchema } from '../src/products/schemas/product.schema';
import { ProductVariantSchema } from '../src/products/schemas/productVariant.schema';
import { UserSchema } from '../src/users/schemas/user.schema';
import { StorefrontSessionSchema } from '../src/storefront-analytics/schemas/storefront-session.schema';
import { SavedReportSchema } from '../src/analytics/schemas/saved-report.schema';
import { ExchangeRateSchema } from '../src/exchange-rate/schemas/exchange-rate.schema';

const uri = process.env.ANALYTICS_IT_MONGO;
if (!uri) throw new Error('set ANALYTICS_IT_MONGO');
const DIRTY = process.env.DIRTY !== '0';

async function main() {
  const conn = await mongoose.createConnection(uri!, { dbName: 'analytics_dirty_check' }).asPromise();
  await conn.dropDatabase();
  const m = {
    orderModel: conn.model('Order', OrderSchema),
    storeModel: conn.model('Store', StoreSchema),
    productModel: conn.model('Product', ProductSchema),
    productVariantModel: conn.model('ProductVariant', ProductVariantSchema),
    userModel: conn.model('User', UserSchema),
    storefrontSessionModel: conn.model('StorefrontSession', StorefrontSessionSchema),
    savedReportModel: conn.model('SavedReport', SavedReportSchema),
    exchangeRateModel: conn.model('ExchangeRate', ExchangeRateSchema),
    saleModel: conn.model('Sale', new mongoose.Schema({}, { strict: false })),
    automaticDiscountModel: conn.model('AutomaticDiscount', new mongoose.Schema({}, { strict: false })),
    campaignModel: conn.model('Campaign', new mongoose.Schema({}, { strict: false })),
  };
  const raw = (model: any) => model.collection;

  const sellerId = new mongoose.Types.ObjectId().toString();
  const storeId = new mongoose.Types.ObjectId();
  const STORE = storeId.toString();
  const now = new Date();
  const day = (n: number) => new Date(now.getTime() - n * 86400000);

  // Store: odd-but-possible settings (PKR currency, no timezone, no country)
  await raw(m.storeModel).insertOne({ _id: storeId, sellerId, isDelete: false, name: 'Dirty', slug: 'dirty', baseCurrency: 'PKR', status: 'active', createdAt: day(60), updatedAt: day(1) });
  await raw(m.exchangeRateModel).insertOne({ currency: 'PKR', ratePerUSD: 278, isRejected: false, effectiveFrom: day(5) });

  const so = (over: any = {}) => ({
    storeId: STORE, sellerId, status: 'completed', subtotal: 100, taxAmount: 10,
    items: [{ productId: 'p1', variantId: 'v1', name: 'A', quantity: 1, totalPrice: 100, refundedAmount: 0, status: 'active' }], ...over,
  });
  const order = (over: any = {}, sellerOrder: any = so()) => ({
    isDelete: false, createdAt: day(2), updatedAt: day(2), userId: 'u1', currency: 'PKR', ratePerUSD: 278, subtotal: 100, shippingFee: 5,
    paymentType: 'cod', trafficSource: 'direct', sellerOrders: [sellerOrder], ...over,
  });
  const clean = [order(), order({ userId: 'u2', createdAt: day(40) }, so({ status: 'cancelled' })), order({ userId: 'u1', createdAt: day(9) })];
  const dirty = [
    order({ userId: 'u3', ratePerUSD: '278.5' }),
    order({ userId: 'u4' }, so({ subtotal: '250', taxAmount: 'abc' })),
    order({ userId: 'u5' }, so({ subtotal: null, taxAmount: null, items: undefined })),
    order({ userId: 'u6', subtotal: '100', shippingFee: 'free' }, so({ items: [{ productId: 'p2', totalPrice: '90', refundedAmount: 'x', quantity: '2', status: 'active' }] })),
    order({ userId: 'u7', ratePerUSD: 0 }),
    order({ userId: 'u8', sellerOrders: [] }),
    order({ userId: 'u9' }, so({ items: [{ productId: 'p3', totalPrice: 50, giftCardDiscountUSD: '20', refundedAmount: 10, status: 'active' }] })),
    order({ userId: 'u10', currency: undefined, ratePerUSD: undefined, paymentType: undefined, trafficSource: undefined }),
    order({ userId: null, customerId: null }),
    order({ userId: 'u11', fxSnapshots: [{ currency: 'PKR', ratePerUSD: '280' }] }),
  ];
  await raw(m.orderModel).insertMany([...clean, ...(DIRTY ? dirty : [])].map((o: any, i) => ({ ...o, orderNumber: `T-${i}` })) as any[]);
  await raw(m.productModel).insertMany([
    { _id: new mongoose.Types.ObjectId(), storeId: STORE, sellerId, name: 'A', status: 'active', isDelete: false, createdAt: day(30) },
    { _id: new mongoose.Types.ObjectId(), storeId: STORE, sellerId, name: 'No stock fields', status: 'active', isDelete: false },
  ] as any[]);
  await raw(m.productVariantModel).insertMany([
    { productId: 'p1', storeId: STORE, stock: '5', price: 'x', isDelete: false },
    { productId: 'p2', storeId: STORE, isDelete: false },
  ] as any[]);
  await raw(m.storefrontSessionModel).insertMany([
    { storeId: STORE, sessionId: 's1', startedAt: day(1), converted: true, addedToCart: true, reachedCheckout: true, source: 'direct' },
    { storeId: STORE, sessionId: 's2', startedAt: day(1) },
  ] as any[]);

  const redis: any = { isConnected: false };
  const db: any = { repositories: m };
  const analytics: any = new AnalyticsService(db, redis);
  const reports: any = new AnalyticsReportsService(db, redis, analytics);

  const q = { storeId: STORE, range: '30d' };
  const cases: [string, () => Promise<any>][] = [];
  const A = (name: string, fn: (extra?: any) => Promise<any>, extra?: any) => cases.push([name, () => fn(extra)]);
  for (const range of ['7d', '30d', '90d', '12m']) {
    const qq = { ...q, range, compareToPreviousPeriod: true };
    A(`overview ${range}`, () => analytics.getOverview(sellerId, STORE, qq));
    A(`summary(overview) ${range}`, () => reports.getSalesSummary(sellerId, STORE, qq));
    A(`revenue-over-time ${range}`, () => analytics.getRevenueOverTime(sellerId, STORE, qq));
    A(`orders-over-time ${range}`, () => analytics.getOrdersOverTime(sellerId, STORE, qq));
    A(`traffic-sources ${range}`, () => analytics.getTrafficSources(sellerId, STORE, qq));
    A(`top-products ${range}`, () => analytics.getTopProducts(sellerId, STORE, qq));
    A(`customers ${range}`, () => analytics.getCustomerAnalytics(sellerId, STORE, qq));
    A(`product-performance ${range}`, () => analytics.getProductPerformance(sellerId, STORE, qq));
    A(`payment-methods ${range}`, () => analytics.getPaymentMethods(sellerId, STORE, qq));
    A(`revenue-breakdown ${range}`, () => analytics.getRevenueBreakdown(sellerId, STORE, qq));
    A(`sessions ${range}`, () => analytics.getSessionsReport(sellerId, STORE, qq));
    A(`sales-by variant ${range}`, () => reports.getSalesBy(sellerId, STORE, { ...qq, dimension: 'variant' }));
    A(`sales-by discount ${range}`, () => reports.getSalesBy(sellerId, STORE, { ...qq, dimension: 'discount' }));
    A(`sales-by channel ${range}`, () => reports.getSalesBy(sellerId, STORE, { ...qq, dimension: 'channel' }));
    A(`cohorts ${range}`, () => reports.getCohorts(sellerId, STORE, qq));
  }
  A('today', () => analytics.getTodaySummary(sellerId, STORE));
  A('sales-forecast', () => analytics.getSalesForecast(sellerId, STORE));
  A('weekday-performance', () => analytics.getWeekdayPerformance(sellerId, STORE));
  A('trending-products', () => analytics.getTrendingProducts(sellerId, STORE));
  A('inventory-insights', () => analytics.getInventoryInsights(sellerId, STORE));
  A('live', () => analytics.getLiveView(sellerId, STORE));
  A('inventory-abc', () => reports.getInventoryAbc(sellerId, STORE));
  A('saved-reports', () => analytics.listSavedReports(sellerId, STORE));
  for (const section of ['revenue', 'orders', 'products', 'customers']) A(`export csv ${section}`, () => analytics.exportCsv(sellerId, STORE, { ...q, section }));
  for (const section of ['sales-summary', 'sales-by-variant', 'cohorts', 'inventory-abc']) A(`report csv ${section}`, () => reports.exportCsv(sellerId, STORE, { ...q, section }));
  A('export pdf', () => analytics.exportPdf(sellerId, STORE, { ...q, section: 'revenue' }));

  let bad = 0;
  for (const [name, fn] of cases) {
    try { await fn(); console.log(`OK   ${name}`); }
    catch (e: any) { bad++; console.log(`FAIL ${name}  ${String(e?.message ?? e).slice(0, 150)}`); }
  }
  console.log(`\n${cases.length} checks, ${bad ? bad + ' FAILED' : 'ALL OK'} (dirty data ${DIRTY ? 'ON' : 'OFF'})`);
  await conn.close();
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
