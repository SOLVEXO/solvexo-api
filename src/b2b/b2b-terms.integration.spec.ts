/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for wholesale payment terms: placing an order on terms (credit limit, method allow-list), installments,
 * overdue, outstanding report. Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-terms.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { PaymentService } from '../payment/payment.service';
import { B2BOrdersService } from './b2b-orders.service';
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
const stub = (): any => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });
const actor = { id: 'seller-1', role: 'seller' };

d('B2B payment terms on a real MongoDB', () => {
  let conn: Connection;
  let repos: any;
  let pay: any;
  let ordersSvc: B2BOrdersService;
  let markPaid: jest.Mock;
  const STORE = String(new Types.ObjectId());
  const OTHER_STORE = String(new Types.ObjectId());
  const SELLER = String(new Types.ObjectId());
  const COMPANY = String(new Types.ObjectId());
  const PID = String(new Types.ObjectId());

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2bterms_it_${Date.now()}` }).asPromise();
    const mk = (name: string, schema: any) => conn.model(name, schema);
    repos = {
      orderModel: mk('Order', OrderSchema), addressModel: mk('Address', AddressSchema), productModel: mk('Product', ProductSchema),
      productVariantModel: mk('ProductVariant', ProductVariantSchema), storeModel: mk('Store', StoreSchema), couponModel: mk('Coupon', CouponSchema),
      checkoutModel: mk('Checkout', CheckoutSchema), paymentTransactionModel: mk('PaymentTransaction', PaymentTransactionSchema),
      cartModel: mk('Cart', new mongoose.Schema({}, { strict: false })), userModel: mk('User', new mongoose.Schema({}, { strict: false })),
    };
    for (const s of [STORE, OTHER_STORE]) await repos.storeModel.collection.insertOne({ _id: new Types.ObjectId(s), slug: 'st-' + s, sellerId: SELLER, baseCurrency: 'PKR', isDelete: false });
    pay = Object.create(PaymentService.prototype);
    for (const k of ['notificationsService', 'financeService', 'giftCardsService', 'abandonedCartService', 'affiliateService', 'storeCreditService', 'activityLogService']) pay[k] = stub();
    pay.exchangeRateService = { convertWithSnapshots: (n: number) => n };
    pay.databaseService = { repositories: repos };
    pay.round = (n: number) => Math.round(n * 100) / 100;
    pay.removeCheckedOutItemsFromCart = jest.fn().mockResolvedValue(undefined);
    markPaid = jest.fn().mockResolvedValue({ success: true });
    ordersSvc = new B2BOrdersService({ repositories: repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, { get: () => ({ markPaid }) } as any);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const variant = async (storeId = STORE, stock = 100) => {
    const vid = new Types.ObjectId();
    await repos.productVariantModel.collection.insertOne({ _id: vid, productId: PID, storeId, sku: 'S' + vid, price: 100, stock, committedStock: 0, damagedStock: 0, inTransitStock: 0, isDelete: false, options: [], unlimitedStock: false });
    return vid;
  };
  const checkoutFor = async (userId: string, lines: { vid: Types.ObjectId; storeId?: string; total: number }[], b2b: any) => {
    const _id = new Types.ObjectId();
    const items = lines.map((l) => ({ type: 'physical', productId: PID, variantId: String(l.vid), storeId: l.storeId ?? STORE, sellerId: SELLER, name: 'P', quantity: 1, unitPrice: l.total, price: l.total, totalPrice: l.total, currency: 'PKR', taxUSD: 0, options: [] }));
    await repos.checkoutModel.collection.insertOne({ _id, userId, status: 'pending', currency: 'PKR', fxSnapshots: [], addressId: null, totalAmount: lines.reduce((s, l) => s + l.total, 0), isDelete: false, items, b2b });
    return String(_id);
  };
  const snap = (over: any = {}) => ({ companyId: COMPANY, companyName: 'Acme', locationId: 'loc', buyerRole: 'ordering', poNumber: 'PO-9', allowedPaymentMethods: [], paymentTerms: { type: 'net', netDays: 30 }, taxExempt: false, creditLimit: null, depositPercent: 0, ...over });
  const place = async (lines: any[], b2b: any) => { const userId = String(new Types.ObjectId()); return pay.b2bTermsPayment(userId, await checkoutFor(userId, lines, b2b)); };
  const orderOf = async (res: any) => (await repos.orderModel.collection.findOne({ _id: new Types.ObjectId(res.data.orders[0].orderId) })) as any;

  it('places an unpaid order on net-30 terms with PO number, due date and reserved stock', async () => {
    const vid = await variant();
    const res = await place([{ vid, total: 1000 }], snap({ depositPercent: 20 }));
    const o = await orderOf(res);
    expect(o).toMatchObject({ paymentType: 'b2b_terms', isPaid: false });
    expect(o.b2b).toMatchObject({ companyId: COMPANY, poNumber: 'PO-9', total: o.totalAmount, depositRequired: o.totalAmount * 0.2, paidTotal: 0, status: 'unpaid', terms: { type: 'net', netDays: 30 } });
    expect(new Date(o.b2b.dueDate).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(((await repos.productVariantModel.collection.findOne({ _id: vid })) as any).committedStock).toBe(1);
  });

  it('refuses terms for retail checkouts, companies without terms, multi-store carts, and when the method list excludes terms', async () => {
    const vid = await variant(); const v2 = await variant(OTHER_STORE);
    await expect(place([{ vid, total: 10 }], null)).rejects.toThrow(/not available for your account/);
    await expect(place([{ vid, total: 10 }], snap({ paymentTerms: null }))).rejects.toThrow(/not available for your account/);
    await expect(place([{ vid, total: 10 }, { vid: v2, storeId: OTHER_STORE, total: 10 }], snap())).rejects.toThrow(/one store at a time/);
    await expect(place([{ vid, total: 10 }], snap({ allowedPaymentMethods: ['manual_bank_transfer'] }))).rejects.toThrow(/not available for your company/);
    await expect(place([{ vid, total: 10 }], snap({ allowedPaymentMethods: ['b2b_terms'] }))).resolves.toBeTruthy();
  });

  it('credit limit: refuses an order above the remaining credit, and a cancelled order gives the credit back', async () => {
    const company = String(new Types.ObjectId());
    const b2b = snap({ companyId: company, creditLimit: 1000 });
    const v = await variant();
    const first = await place([{ vid: v, total: 700 }], b2b);
    await expect(place([{ vid: v, total: 400 }], b2b)).rejects.toThrow(/credit limit/);
    await expect(place([{ vid: v, total: 300 }], b2b)).resolves.toBeTruthy(); // exactly fills the limit
    await repos.orderModel.collection.updateOne({ _id: new Types.ObjectId(first.data.orders[0].orderId) }, { $set: { orderStatus: 'cancelled' } });
    await expect(place([{ vid: v, total: 650 }], b2b)).resolves.toBeTruthy();
  });

  it('another company\'s debt does not count against this company\'s limit', async () => {
    const v = await variant();
    await place([{ vid: v, total: 900 }], snap({ companyId: String(new Types.ObjectId()), creditLimit: 1000 }));
    await expect(place([{ vid: v, total: 900 }], snap({ companyId: String(new Types.ObjectId()), creditLimit: 1000 }))).resolves.toBeTruthy();
  });

  const terms = async (total = 100, over: any = {}) => {
    const v = await variant();
    const res = await place([{ vid: v, total }], snap(over));
    const o = await orderOf(res);
    return { id: String(o._id), total: o.b2b.total };
  };

  it('installments: partial -> partial status, exact balance, overpayment refused, method required', async () => {
    const { id, total } = await terms(100);
    const r1 = await ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: 40, method: 'Bank transfer', reference: 'TX-1' });
    expect(r1.status).toBe('partial');
    expect(markPaid).not.toHaveBeenCalled();
    await expect(ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: total, method: 'cash' })).rejects.toThrow(/more than the outstanding/);
    await expect(ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: 10 })).rejects.toThrow(/method is required/);
    await expect(ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: -5, method: 'cash' })).rejects.toThrow(/above 0/);
    const o: any = await repos.orderModel.collection.findOne({ _id: new Types.ObjectId(id) });
    expect(o.b2b.paidTotal).toBe(40);
    expect(o.b2b.status).toBe('partial');
  });

  it('paying the last installment marks the order paid through the normal markPaid path', async () => {
    markPaid.mockClear();
    const { id, total } = await terms(100);
    await ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: 60, method: 'bank' });
    const r = await ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: total - 60, method: 'cash' });
    expect(r).toMatchObject({ status: 'paid', markedPaid: true });
    expect(markPaid).toHaveBeenCalledWith(SELLER, STORE, id, { actorId: 'seller-1', actorRole: 'seller' });
  });

  it('parallel payments can never exceed the balance', async () => {
    const { id } = await terms(100);
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: 40, method: 'bank' })));
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(2);
    const o: any = await repos.orderModel.collection.findOne({ _id: new Types.ObjectId(id) });
    expect(o.b2b.paidTotal).toBeLessThanOrEqual(100.004);
    expect(o.b2b.payments.filter((p: any) => !p.voided).reduce((s: number, p: any) => s + p.amount, 0)).toBe(o.b2b.paidTotal);
  });

  it('voiding a payment restores the balance once, and not on a paid order', async () => {
    const { id } = await terms(100);
    const r = await ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: 30, method: 'bank' });
    await ordersSvc.voidPayment(STORE, actor, id, String(r.payment._id));
    await expect(ordersSvc.voidPayment(STORE, actor, id, String(r.payment._id))).rejects.toThrow(/not found or already voided/);
    const o: any = await repos.orderModel.collection.findOne({ _id: new Types.ObjectId(id) });
    expect(o.b2b).toMatchObject({ paidTotal: 0, status: 'unpaid' });
    await repos.orderModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { isPaid: true } });
    await expect(ordersSvc.voidPayment(STORE, actor, id, String(r.payment._id))).rejects.toThrow(/already marked paid|not found/);
  });

  it('a cancelled order accepts no payments, and another store cannot see or pay it', async () => {
    const { id } = await terms(100);
    await expect(ordersSvc.recordPayment(OTHER_STORE, SELLER, actor, id, { amount: 10, method: 'bank' })).rejects.toThrow(/Order not found/);
    await expect(ordersSvc.listOrders(OTHER_STORE, {}).then((r) => r.items.some((i: any) => String(i._id) === id))).resolves.toBe(false);
    await repos.orderModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { orderStatus: 'cancelled' } });
    await expect(ordersSvc.recordPayment(STORE, SELLER, actor, id, { amount: 10, method: 'bank' })).rejects.toThrow(/cancelled or refunded/);
  });

  it('overdue filter and outstanding report/CSV (per company, formula-safe)', async () => {
    const company = String(new Types.ObjectId());
    const a = await terms(100, { companyId: company, companyName: '=HYPERLINK("x")' });
    await terms(50, { companyId: company, companyName: '=HYPERLINK("x")' });
    await repos.orderModel.collection.updateOne({ _id: new Types.ObjectId(a.id) }, { $set: { 'b2b.dueDate': new Date(Date.now() - 86_400_000) } });
    await ordersSvc.recordPayment(STORE, SELLER, actor, a.id, { amount: 25, method: 'bank' });

    const overdue = await ordersSvc.listOrders(STORE, { overdue: 'true', companyId: company });
    expect(overdue.items.map((i: any) => String(i._id))).toEqual([a.id]);
    expect(overdue.items[0].receivable).toMatchObject({ outstanding: 75, overdue: true, status: 'partial' });

    const report: any = await ordersSvc.outstandingReport(STORE);
    const row = report.items.find((r: any) => r.companyId === company);
    expect(row).toMatchObject({ orders: 2, outstanding: 125, overdue: 75, currency: 'PKR' });
    expect((await ordersSvc.outstandingReport(OTHER_STORE) as any).items.find((r: any) => r.companyId === company)).toBeUndefined();
    const csv = (await ordersSvc.outstandingReport(STORE, { csv: true })) as string;
    expect(csv.split('\n')[0]).toBe('Company,Currency,Open orders,Outstanding,Overdue,Oldest due date');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
