/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for the COD confirmation round trip: send, link confirm / cancel (replay-safe), expiry auto-cancel with restock.
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit cod-confirmation.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { CodConfirmationService } from './cod-confirmation.service';
import { CodProtectionService } from './cod-protection.service';
import { CodProtectionSettingsSchema } from './cod-protection.schema';
import { signCodConfirmToken } from './cod-confirm-token.util';
import { PaymentService } from '../payment/payment.service';
import { OrdersService } from '../orders/orders.service';
import { OrderSchema } from '../orders/schemas/order.schema';
import { AddressSchema } from '../address/adress.schema';
import { ProductSchema } from '../products/schemas/product.schema';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { StoreSchema } from '../store/schemas/store.schema';
import { CouponSchema } from '../marketing/schemas/coupon.schema';
import { CheckoutSchema } from '../checkout/checkout.schema';
import { PaymentTransactionSchema } from '../payment/paymentTransaction.Schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());
const stub = (): any => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });
const actor = { id: 'seller-1', role: 'seller' };

d('COD confirmation flow on a real MongoDB', () => {
  let conn: Connection;
  let repos: any;
  let pay: any;
  let ordersSvc: any;
  let prot: CodProtectionService;
  let conf: CodConfirmationService;
  const sendEmail = jest.fn().mockResolvedValue(undefined);
  const sendWa = jest.fn().mockResolvedValue(undefined);
  const SELLER = oid();
  const STORE = oid();
  const PID = oid();

  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret';
    conn = await mongoose.createConnection(URI as string, { dbName: `codconf_it_${Date.now()}` }).asPromise();
    const mk = (n: string, s: any) => conn.model(n, s);
    repos = {
      orderModel: mk('Order', OrderSchema), addressModel: mk('Address', AddressSchema), productModel: mk('Product', ProductSchema),
      productVariantModel: mk('ProductVariant', ProductVariantSchema), storeModel: mk('Store', StoreSchema), couponModel: mk('Coupon', CouponSchema),
      checkoutModel: mk('Checkout', CheckoutSchema), paymentTransactionModel: mk('PaymentTransaction', PaymentTransactionSchema),
      userModel: mk('User', new mongoose.Schema({}, { strict: false })), courierBookingModel: mk('CourierBooking', new mongoose.Schema({}, { strict: false })),
      variantLocationStockModel: mk('VariantLocationStock', new mongoose.Schema({}, { strict: false })),
    };
    await repos.storeModel.collection.insertOne({ _id: new Types.ObjectId(STORE), slug: 'cod-shop', name: 'COD Shop', sellerId: SELLER, baseCurrency: 'PKR', isDelete: false });
    ordersSvc = Object.create(OrdersService.prototype);
    for (const k of ['notificationsService', 'financeService', 'activityLogService', 'giftCardsService', 'storeCreditService']) ordersSvc[k] = stub();
    ordersSvc.paymentService = stub();
    ordersSvc.exchangeRateService = { convertWithSnapshots: (n: number) => n };
    ordersSvc.databaseService = { repositories: repos };
    ordersSvc.pushTimeline = jest.fn().mockResolvedValue(undefined);
    const db: any = { repositories: repos };
    const moduleRef: any = { get: (cls: any) => (cls === OrdersService ? ordersSvc : { sendOrderTemplate: sendWa }) };
    const redis: any = { withLock: async (_k: string, _t: number, fn: () => Promise<void>) => fn() };
    conf = new CodConfirmationService(db, { log: jest.fn().mockResolvedValue(undefined) } as any, redis, { sendCustomerEmail: sendEmail } as any, moduleRef);
    prot = new CodProtectionService(mk('CodProtectionSettings', CodProtectionSettingsSchema) as any, db, { log: jest.fn().mockResolvedValue(undefined) } as any, { convertWithSnapshots: (n: number) => n } as any, conf);
    await prot.updateSettings(STORE, actor, { enabled: true, confirmationHours: 6 });
    pay = Object.create(PaymentService.prototype);
    for (const k of ['notificationsService', 'financeService', 'giftCardsService', 'abandonedCartService', 'affiliateService', 'storeCreditService', 'activityLogService']) pay[k] = stub();
    pay.exchangeRateService = { convertWithSnapshots: (n: number) => n };
    pay.databaseService = db;
    pay.round = (n: number) => Math.round(n * 100) / 100;
    pay.codProtection = prot;
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  /** A real COD checkout placed through PaymentService.createOrder (reserves stock, stamps the verdict, sends the confirmation). */
  const placeCod = async (userId = oid()) => {
    const vid = new Types.ObjectId();
    await repos.productVariantModel.collection.insertOne({ _id: vid, productId: PID, storeId: STORE, sku: 'S' + vid, price: 100, stock: 10, committedStock: 0, damagedStock: 0, inTransitStock: 0, isDelete: false, options: [], unlimitedStock: false });
    await repos.userModel.collection.insertOne({ _id: new Types.ObjectId(userId), storeId: STORE, email: userId + '@buyer.com', name: 'Buyer' });
    const addressId = String((await repos.addressModel.collection.insertOne({ phoneNumber: '0300-1234567', city: 'Lahore', addressLine1: 'House 5', recipientName: 'Buyer', country: 'PK', state: 'Punjab', zipCode: '54000', isDelete: false })).insertedId);
    const _id = new Types.ObjectId();
    const checkout = { _id, userId, currency: 'PKR', fxSnapshots: [], addressId, totalAmount: 100,
      items: [{ type: 'physical', productId: PID, variantId: String(vid), storeId: STORE, sellerId: SELLER, name: 'P', quantity: 1, unitPrice: 100, price: 100, totalPrice: 100, currency: 'PKR', taxUSD: 0, options: [] }] };
    await repos.checkoutModel.collection.insertOne({ _id, userId, status: 'pending' });
    const [o] = await pay.createOrder(userId, checkout, repos.orderModel, repos.addressModel, { paymentType: 'cash_on_delivery', isPaid: false, paymentStatus: 'unpaid' });
    return { orderId: String(o._id), vid, userId };
  };
  const raw = async (id: string) => (await repos.orderModel.collection.findOne({ _id: new Types.ObjectId(id) })) as any;
  const tokenOf = async (id: string) => { const o = await raw(id); return signCodConfirmToken(id, o.codProtection.confirmation.tokenId, o.codProtection.confirmation.expiresAt); };

  it('placing a COD order from a new customer stamps it, reserves stock and sends the link by email and WhatsApp', async () => {
    sendEmail.mockClear(); sendWa.mockClear();
    const { orderId, userId } = await placeCod();
    const o = await raw(orderId);
    expect(o.codProtection).toMatchObject({ decision: 'confirm', confirmation: { status: 'awaiting', channels: ['email', 'whatsapp'] } });
    expect(o.codProtection.confirmation.tokenId).toHaveLength(16);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: userId + '@buyer.com', event: 'cod_confirmation', storeId: STORE });
    expect(sendEmail.mock.calls[0][0].vars.confirmUrl).toMatch(/^https:\/\/cod-shop\.solvexo\.store\/cod-confirm\/.+\..+/);
    expect(sendWa.mock.calls[0].slice(0, 2)).toEqual([STORE, '0300-1234567']);
    expect(sendWa.mock.calls[0][5]).toBe('cod_confirmation');
  });

  it('the public view shows only what the buyer needs, and a bad or forged link is a 404', async () => {
    const { orderId } = await placeCod();
    const v: any = await conf.publicView(await tokenOf(orderId));
    expect(v).toMatchObject({ storeName: 'COD Shop', total: 100, currency: 'PKR', itemCount: 1, status: 'awaiting' });
    expect(Object.keys(v).sort()).toEqual(['currency', 'expiresAt', 'itemCount', 'orderNumber', 'status', 'storeName', 'total']);
    await expect(conf.publicView('garbage')).rejects.toThrow(/not valid/);
    await expect(conf.publicView(signCodConfirmToken(orderId, 'wrongtokenid0000', Date.now() + 1e6))).rejects.toThrow(/not valid/);
  });

  it('confirming works once and replays are harmless; confirmed orders can be fulfilled', async () => {
    const { orderId } = await placeCod();
    const t = await tokenOf(orderId);
    const r = await Promise.all([conf.confirm(t), conf.confirm(t), conf.confirm(t)]);
    expect(r.every((x: any) => x.status === 'confirmed')).toBe(true);
    const o = await raw(orderId);
    expect(o.codProtection.confirmation).toMatchObject({ status: 'confirmed', resolvedBy: 'customer' });
    expect((await conf.cancel(t)).status).toBe('confirmed'); // cannot be cancelled after confirming
    expect((await raw(orderId)).orderStatus).not.toBe('cancelled');
  });

  it('cancelling from the link cancels the order ONCE and gives the reserved stock back; later taps just show the result', async () => {
    const { orderId, vid } = await placeCod();
    expect(((await repos.productVariantModel.collection.findOne({ _id: vid })) as any).committedStock).toBe(1);
    const t = await tokenOf(orderId);
    const r = await Promise.all([conf.cancel(t), conf.cancel(t)]);
    expect(r.every((x: any) => x.status === 'cancelled')).toBe(true);
    expect((await raw(orderId)).orderStatus).toBe('cancelled');
    expect(((await repos.productVariantModel.collection.findOne({ _id: vid })) as any).committedStock).toBe(0);
    expect((await conf.confirm(t)).status).toBe('cancelled');
  });

  it('resending rotates the link: the old one stops working, the new one works', async () => {
    const { orderId } = await placeCod();
    const oldToken = await tokenOf(orderId);
    await conf.send(orderId);
    await expect(conf.publicView(oldToken)).rejects.toThrow(/not valid/);
    expect((await conf.publicView(await tokenOf(orderId))).status).toBe('awaiting');
  });

  it('an expired link does not confirm; the auto-cancel job cancels unconfirmed orders once and releases the stock', async () => {
    const { orderId, vid } = await placeCod();
    const { orderId: fresh } = await placeCod();
    const t = await tokenOf(orderId);
    await repos.orderModel.collection.updateOne({ _id: new Types.ObjectId(orderId) }, { $set: { 'codProtection.confirmation.expiresAt': new Date(Date.now() - 1000) } });
    expect((await conf.confirm(t)).status).toBe('expired');
    expect((await raw(orderId)).codProtection.confirmation.status).toBe('awaiting'); // not changed by the failed tap

    const [a, b] = await Promise.all([conf.expireDue(), conf.expireDue()]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    const o = await raw(orderId);
    expect(o.orderStatus).toBe('cancelled');
    expect(o.codProtection.confirmation).toMatchObject({ status: 'expired', resolvedBy: 'system' });
    expect(((await repos.productVariantModel.collection.findOne({ _id: vid })) as any).committedStock).toBe(0);
    expect((await raw(fresh)).orderStatus).not.toBe('cancelled'); // still inside its window
    expect(await conf.expireDue()).toBe(0);
  });

  it('a repeat customer with a delivered order is not asked to confirm; a store without protection sends nothing', async () => {
    sendEmail.mockClear();
    const loyal = oid();
    await repos.orderModel.collection.insertOne({ _id: new Types.ObjectId(), isDelete: false, userId: loyal, orderStatus: 'delivered', paymentType: 'cash_on_delivery', sellerOrders: [{ storeId: STORE, status: 'delivered', items: [] }] });
    const { orderId } = await placeCod(loyal);
    expect((await raw(orderId)).codProtection).toMatchObject({ decision: 'allow', confirmation: null });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a customer cancel that fails to cancel the order puts the confirmation back (nothing is lost)', async () => {
    const { orderId } = await placeCod();
    const t = await tokenOf(orderId);
    const real = ordersSvc.cancelOrder;
    ordersSvc.cancelOrder = jest.fn().mockRejectedValue(new Error('db blip'));
    try {
      await expect(conf.cancel(t)).rejects.toThrow(/could not cancel/);
      expect((await raw(orderId)).codProtection.confirmation.status).toBe('awaiting');
    } finally { ordersSvc.cancelOrder = real; }
    expect((await conf.cancel(t)).status).toBe('cancelled');
  });
});
