/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for COD protection: store-scoped history, verdicts, stamping, manual confirmation and the fulfilment guard.
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit cod-protection.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { assertCodConfirmedForFulfilment, CodProtectionService } from './cod-protection.service';
import { CodProtectionSettingsSchema } from './cod-protection.schema';
import { OrderSchema } from '../orders/schemas/order.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());
const actor = { id: 'seller-1', role: 'seller' };

d('CodProtectionService on a real MongoDB', () => {
  let conn: Connection;
  let svc: CodProtectionService;
  let m: any;
  const A = oid();
  const B = oid();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `cod_it_${Date.now()}` }).asPromise();
    m = {
      settings: conn.model('CodProtectionSettings', CodProtectionSettingsSchema),
      orders: conn.model('Order', OrderSchema),
      addresses: conn.model('Address', new mongoose.Schema({}, { strict: false })),
      stores: conn.model('Store', new mongoose.Schema({}, { strict: false })),
      couriers: conn.model('CourierBooking', new mongoose.Schema({}, { strict: false })),
    };
    await m.settings.init();
    for (const s of [A, B]) await m.stores.collection.insertOne({ _id: new Types.ObjectId(s), baseCurrency: 'PKR' });
    const db: any = { repositories: { orderModel: m.orders, addressModel: m.addresses, storeModel: m.stores, courierBookingModel: m.couriers } };
    svc = new CodProtectionService(m.settings, db, { log: jest.fn().mockResolvedValue(undefined) } as any, { convertWithSnapshots: (n: number) => n } as any);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const order = async (storeId: string, userId: string, over: any = {}) => {
    const _id = new Types.ObjectId();
    await m.orders.collection.insertOne({ _id, isDelete: false, userId, orderNumber: 'ORD-' + _id, orderStatus: 'pending', paymentType: 'cash_on_delivery', sellerOrders: [{ storeId, status: 'pending', items: [{ returnStatus: 'none' }] }], ...over });
    return _id;
  };
  const address = async (over: any = {}) => String((await m.addresses.collection.insertOne({ phoneNumber: '0300-1234567', city: 'Lahore', addressLine1: 'House 5 Street 2', ...over })).insertedId);
  const checkoutFor = async (storeId: string, total = 1000, over: any = {}) => ({ _id: new Types.ObjectId(), currency: 'PKR', fxSnapshots: [], totalAmount: total, addressId: await address(), items: [{ storeId }], ...over });

  it('settings: off by default, validated on save, store-isolated, audited', async () => {
    expect((await svc.getSettings(A)).enabled).toBe(false);
    await svc.updateSettings(A, actor, { enabled: true, maxCodAmount: 5000, blockedPhones: ['0301-1111111'] });
    expect(await svc.getSettings(A)).toMatchObject({ enabled: true, maxCodAmount: 5000, blockedPhones: ['923011111111'] });
    expect((await svc.getSettings(B)).enabled).toBe(false);
    await expect(svc.updateSettings(A, actor, { maxCodAmount: -5 })).rejects.toThrow(/maxCodAmount/);
    expect((await svc.getSettings(A)).maxCodAmount).toBe(5000);
  });

  it('history is store-scoped: another store\'s orders never count, phone matches across accounts of the same store', async () => {
    const u = oid();
    await order(A, u, { orderStatus: 'delivered' });
    await order(A, u, { orderStatus: 'cancelled' });
    await order(B, u, { orderStatus: 'cancelled' }); // other store: ignored
    const rto = await order(A, u);
    await m.couriers.collection.insertOne({ storeId: A, orderId: String(rto), rto: true });
    await order(A, oid(), { orderStatus: 'delivered', codProtection: { phoneKey: '923007654321' } });
    expect(await svc.history(A, u, null)).toEqual({ delivered: 1, cancelled: 1, returned: 0, rto: 1 });
    expect(await svc.history(B, u, null)).toMatchObject({ cancelled: 1, delivered: 0, rto: 0 });
    expect(await svc.history(A, oid(), '923007654321')).toMatchObject({ delivered: 1 });
  });

  it('verdicts: allow, confirm (new customer / value / city), block (limit, blocked phone) and a courier RTO history', async () => {
    const S = oid();
    await m.stores.collection.insertOne({ _id: new Types.ObjectId(S), baseCurrency: 'PKR' });
    await svc.updateSettings(S, actor, { enabled: true, maxCodAmount: 5000, confirmAboveAmount: 3000, flaggedCities: ['Karachi'], blockedPhones: ['0302-2222222'] });
    const repeat = oid();
    await order(S, repeat, { orderStatus: 'delivered' });

    expect((await svc.evaluateCheckout(await checkoutFor(S, 1000), repeat))?.evaluation.decision).toBe('allow');
    expect((await svc.evaluateCheckout(await checkoutFor(S, 1000), oid()))?.evaluation.decision).toBe('confirm'); // new customer
    expect((await svc.evaluateCheckout(await checkoutFor(S, 3500), repeat))?.evaluation.decision).toBe('confirm'); // value
    expect((await svc.evaluateCheckout(await checkoutFor(S, 1000, { addressId: await address({ city: 'karachi' }) }), repeat))?.evaluation.decision).toBe('confirm');
    expect((await svc.evaluateCheckout(await checkoutFor(S, 6000), repeat))?.evaluation.decision).toBe('block_cod');
    expect((await svc.evaluateCheckout(await checkoutFor(S, 1000, { addressId: await address({ phoneNumber: '+92 302 2222222' }) }), repeat))?.evaluation.decision).toBe('block_cod');
    await expect(svc.assertCodAllowed(await checkoutFor(S, 6000), repeat)).rejects.toMatchObject({ response: { code: 'COD_NOT_AVAILABLE' } });
    await expect(svc.assertCodAllowed(await checkoutFor(S, 1000), repeat)).resolves.toBeTruthy();

    const rto = await order(S, repeat);
    await m.couriers.collection.insertOne({ storeId: S, orderId: String(rto), rto: true });
    const e = (await svc.evaluateCheckout(await checkoutFor(S, 1000), repeat))!.evaluation;
    expect(e.reasons.some((r) => r.code === 'rto')).toBe(true);
  });

  it('a store without protection is never affected, and a multi-store cart takes the strictest store', async () => {
    const plain = oid(); const strict = oid();
    await m.stores.collection.insertMany([{ _id: new Types.ObjectId(plain), baseCurrency: 'PKR' }, { _id: new Types.ObjectId(strict), baseCurrency: 'PKR' }]);
    await svc.updateSettings(strict, actor, { enabled: true, maxCodAmount: 100 });
    expect(await svc.evaluateCheckout(await checkoutFor(plain, 999999), oid())).toBeNull();
    const both = await checkoutFor(plain, 500, { items: [{ storeId: plain }, { storeId: strict }] });
    expect((await svc.evaluateCheckout(both, oid()))?.evaluation.decision).toBe('block_cod');
  });

  it('stamping: a confirm verdict starts the confirmation clock, an allow verdict stamps without it, non-COD orders are skipped', async () => {
    const S = oid();
    await m.stores.collection.insertOne({ _id: new Types.ObjectId(S), baseCurrency: 'PKR' });
    await svc.updateSettings(S, actor, { enabled: true, confirmationHours: 6 });
    const newbie = oid();
    const o1 = await m.orders.collection.findOne({ _id: await order(S, newbie) });
    const o2 = await m.orders.collection.findOne({ _id: await order(S, newbie, { paymentType: 'stripe' }) });
    const now = new Date('2026-04-01T10:00:00Z');
    await svc.stampOrders(await checkoutFor(S, 1000), [o1, o2], newbie, now);
    const s1: any = ((await m.orders.collection.findOne({ _id: o1._id })) as any).codProtection;
    expect(s1).toMatchObject({ decision: 'confirm', level: expect.any(String), confirmation: { status: 'awaiting', sentAt: null } });
    expect(new Date(s1.confirmation.expiresAt).getTime()).toBe(now.getTime() + 6 * 3_600_000);
    expect(((await m.orders.collection.findOne({ _id: o2._id })) as any).codProtection ?? null).toBeNull();

    const repeat = oid();
    await order(S, repeat, { orderStatus: 'delivered' });
    const o3 = await m.orders.collection.findOne({ _id: await order(S, repeat) });
    await svc.stampOrders(await checkoutFor(S, 1000), [o3], repeat, now);
    expect(((await m.orders.collection.findOne({ _id: o3._id })) as any).codProtection).toMatchObject({ decision: 'allow', confirmation: null });
  });

  it('manual confirmation: once, only for the right store, audited; then fulfilment is allowed', async () => {
    const S = oid();
    const id = await order(S, oid(), { codProtection: { decision: 'confirm', confirmation: { status: 'awaiting', expiresAt: new Date(Date.now() + 3600_000) } } });
    const raw = await m.orders.collection.findOne({ _id: id });
    expect(() => assertCodConfirmedForFulfilment(raw)).toThrow(/waiting for the customer/);

    await expect(svc.manualConfirm(B, actor, String(id), 'x')).rejects.toThrow(/not waiting/);
    await svc.manualConfirm(S, actor, String(id), '  called him  ');
    const done: any = await m.orders.collection.findOne({ _id: id });
    expect(done.codProtection.confirmation).toMatchObject({ status: 'confirmed', resolvedBy: 'seller' });
    expect(done.codProtection.override).toMatchObject({ by: 'seller-1', note: 'called him' });
    expect(() => assertCodConfirmedForFulfilment(done)).not.toThrow();
    await expect(svc.manualConfirm(S, actor, String(id))).rejects.toThrow(/not waiting/);
    await expect(svc.manualConfirm(S, actor, 'nope')).rejects.toThrow(/not found/i);
    expect(() => assertCodConfirmedForFulfilment({})).not.toThrow();
  });
});
