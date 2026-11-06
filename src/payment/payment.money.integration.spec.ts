/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB money-path tests: PaymentService.createOrder (stock reservation, pre-order limit, coupon usageLimit) under concurrency.
 * Skipped unless MONGO_TEST_URI is set (a standalone mongod is enough), e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest payment.money.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 * Only the database is real: every other collaborator is a permissive stub (any method resolves undefined).
 */
import mongoose, { Connection, Types } from 'mongoose';
import { PaymentService } from './payment.service';
import { OrderSchema } from '../orders/schemas/order.schema';
import { AddressSchema } from '../address/adress.schema';
import { ProductSchema } from '../products/schemas/product.schema';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { StoreSchema } from '../store/schemas/store.schema';
import { CouponSchema } from '../marketing/schemas/coupon.schema';
import { CheckoutSchema } from '../checkout/checkout.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

const stub = (): any => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });

d('PaymentService.createOrder on a real MongoDB', () => {
  let conn: Connection;
  let m: any;
  let svc: any;
  const oid = () => new Types.ObjectId();
  const STORE = String(oid());
  const SELLER = String(oid());
  const USER = String(oid());

  const mkVariant = async (extra: any = {}) => {
    const pid = oid();
    await m.productModel.collection.insertOne({ _id: pid, storeId: STORE, sellerId: SELLER, isDelete: false, status: 'active', type: 'physical', name: 'P', slug: 'p-' + pid, createdAt: new Date() });
    const vid = oid();
    await m.productVariantModel.collection.insertOne({
      _id: vid, productId: String(pid), storeId: STORE, sku: 'SKU-' + vid, price: 10, stock: 1, committedStock: 0, damagedStock: 0,
      inTransitStock: 0, isDelete: false, isDefault: true, options: [], unlimitedStock: false, createdAt: new Date(), ...extra,
    });
    return { pid: String(pid), vid: String(vid) };
  };

  const mkCheckout = (v: { pid: string; vid: string }, quantity = 1) => ({
    _id: oid(), userId: USER, currency: 'USD', fxSnapshots: [], addressId: null, totalAmount: 10 * quantity, subtotal: 10 * quantity,
    items: [{
      type: 'physical', productId: v.pid, variantId: v.vid, storeId: STORE, sellerId: SELLER, name: 'P', quantity,
      unitPrice: 10, price: 10, totalPrice: 10 * quantity, currency: 'USD', taxUSD: 0, options: [],
    }],
  });

  const place = async (checkout: any) => {
    await m.checkoutModel.collection.updateOne({ _id: checkout._id }, { $setOnInsert: { userId: USER, status: 'pending' } }, { upsert: true });
    return placeRaw(checkout);
  };
  const placeRaw = (checkout: any) =>
    svc.createOrder(USER, checkout, m.orderModel, m.addressModel, { paymentType: 'cash_on_delivery', isPaid: false, paymentStatus: 'unpaid' });

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `payment_it_${Date.now()}` }).asPromise();
    m = {
      orderModel: conn.model('Order', OrderSchema),
      addressModel: conn.model('Address', AddressSchema),
      productModel: conn.model('Product', ProductSchema),
      productVariantModel: conn.model('ProductVariant', ProductVariantSchema),
      storeModel: conn.model('Store', StoreSchema),
      couponModel: conn.model('Coupon', CouponSchema),
      checkoutModel: conn.model('Checkout', CheckoutSchema),
    };
    await m.storeModel.collection.insertOne({ _id: new Types.ObjectId(STORE), sellerId: SELLER, baseCurrency: 'USD', isDelete: false });
    svc = Object.create(PaymentService.prototype);
    for (const k of ['notificationsService', 'configService', 'promotionsService', 'financeService', 'adminConfigService', 'activityLogService', 'giftCardsService',
      'stripeConnectService', 'commissionRulesService', 'abandonedCartService', 'affiliateService', 'draftOrdersService', 'emailService', 'storeCreditService']) svc[k] = stub();
    svc.exchangeRateService = { convertWithSnapshots: (n: number) => n, getRatePerUSD: jest.fn().mockResolvedValue(1) };
    svc.databaseService = { repositories: m };
    svc.round = (n: number) => Math.round(n * 100) / 100;
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('five buyers racing for the LAST unit: exactly one order, committedStock stays 1, the rest get stock-unavailable', async () => {
    const v = await mkVariant({ stock: 1 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => place(mkCheckout(v))));

    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r: any) => /Stock not available/.test(String(r.reason?.message)))).toBe(true);
    const variant: any = await m.productVariantModel.collection.findOne({ _id: new Types.ObjectId(v.vid) });
    expect(variant.committedStock).toBe(1);
    expect(variant.stock).toBe(1);
    expect(await m.orderModel.countDocuments({ 'sellerOrders.items.variantId': v.vid })).toBe(1);
  });

  it('never reserves beyond stock across many parallel orders of quantity 2 (stock 5 -> at most 2 orders)', async () => {
    const v = await mkVariant({ stock: 5 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => place(mkCheckout(v, 2))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const variant: any = await m.productVariantModel.collection.findOne({ _id: new Types.ObjectId(v.vid) });
    expect(variant.committedStock).toBe(4);
  });

  it('the same checkout placed twice at once creates one order and reserves once (webhook retry)', async () => {
    const v = await mkVariant({ stock: 3 });
    const checkout = mkCheckout(v);
    await Promise.allSettled([place(checkout), place(checkout)]);

    const variant: any = await m.productVariantModel.collection.findOne({ _id: new Types.ObjectId(v.vid) });
    expect(await m.orderModel.countDocuments({ checkoutId: String(checkout._id) })).toBe(1);
    expect(variant.committedStock).toBe(1);
  });

  it('pre-order limit: 3 slots, 5 parallel buyers of 1 -> exactly 3 orders, preorder.sold = 3', async () => {
    const v = await mkVariant({ stock: 0, preorder: { enabled: true, limit: 3, sold: 0, expectedDate: new Date(Date.now() + 864e5 * 10), message: null } });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => place(mkCheckout(v))));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    const variant: any = await m.productVariantModel.collection.findOne({ _id: new Types.ObjectId(v.vid) });
    expect(variant.preorder.sold).toBe(3);
    expect(variant.committedStock).toBe(3);
  });

  it('a multi-line checkout that fails on its 2nd line releases the 1st line reservation', async () => {
    const a = await mkVariant({ stock: 5 });
    const b = await mkVariant({ stock: 0 });
    const checkout: any = mkCheckout(a);
    checkout.items.push({ ...mkCheckout(b).items[0] });

    await expect(place(checkout)).rejects.toThrow(/Stock not available/);

    const va: any = await m.productVariantModel.collection.findOne({ _id: new Types.ObjectId(a.vid) });
    expect(va.committedStock).toBe(0);
    expect(await m.orderModel.countDocuments({ checkoutId: String(checkout._id) })).toBe(0);
  });
});

d('PaymentService.createOrder failure after reserving (real MongoDB)', () => {
  it('REGRESSION: when the order insert fails the reservation (committedStock + preorder.sold) is handed back', async () => {
    const conn2 = await mongoose.createConnection(URI as string, { dbName: `payment_it_f_${Date.now()}` }).asPromise();
    const storeId = String(new Types.ObjectId());
    const orderModel = conn2.model('Order', OrderSchema);
    const variantModel = conn2.model('ProductVariant', ProductVariantSchema);
    const vid = new Types.ObjectId();
    await variantModel.collection.insertOne({ _id: vid, productId: 'p', storeId, sku: 'S', price: 10, stock: 0, committedStock: 0, damagedStock: 0, inTransitStock: 0, isDelete: false,
      options: [], unlimitedStock: false, preorder: { enabled: true, limit: 5, sold: 0, expectedDate: new Date(Date.now() + 864e5 * 9), message: null } });
    await conn2.model('Store', StoreSchema).collection.insertOne({ _id: new Types.ObjectId(storeId), baseCurrency: 'USD', isDelete: false });
    const svc2: any = Object.create(PaymentService.prototype);
    for (const k of ['notificationsService', 'financeService', 'activityLogService', 'giftCardsService', 'abandonedCartService', 'affiliateService', 'storeCreditService']) svc2[k] = stub();
    svc2.exchangeRateService = { convertWithSnapshots: (n: number) => n };
    svc2.databaseService = { repositories: {
      orderModel, addressModel: conn2.model('Address', AddressSchema), productModel: conn2.model('Product', ProductSchema), productVariantModel: variantModel,
      storeModel: conn2.model('Store', StoreSchema), userModel: conn2.model('User', new mongoose.Schema({}, { strict: false })),
      checkoutModel: conn2.model('Checkout', CheckoutSchema),
    } };
    svc2.round = (n: number) => Math.round(n * 100) / 100;
    jest.spyOn(orderModel, 'create').mockRejectedValueOnce(new Error('db blip') as never);
    const checkout = { _id: new Types.ObjectId(), userId: String(new Types.ObjectId()), currency: 'USD', fxSnapshots: [], addressId: null, totalAmount: 10,
      items: [{ type: 'physical', productId: 'p', variantId: String(vid), storeId, sellerId: 's', name: 'P', quantity: 2, unitPrice: 5, price: 5, totalPrice: 10, currency: 'USD', taxUSD: 0, options: [] }] };

    await svc2.databaseService.repositories.checkoutModel.collection.insertOne({ _id: checkout._id, userId: checkout.userId, status: 'pending' });
    await expect(svc2.createOrder(checkout.userId, checkout, orderModel, svc2.databaseService.repositories.addressModel, { paymentType: 'cash_on_delivery', isPaid: false, paymentStatus: 'unpaid' })).rejects.toThrow('db blip');

    const v: any = await variantModel.collection.findOne({ _id: vid });
    expect(v.committedStock).toBe(0);
    expect(v.preorder.sold).toBe(0);
    await conn2.dropDatabase();
    await conn2.close();
  });
});
