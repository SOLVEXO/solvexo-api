/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB test of the seller orders list "view" tabs (unfulfilled / open / unpaid / cod_awaiting): the filter built
 * by applySellerOrderView is run as the same $elemMatch + top-level match the list uses. Skipped unless
 * ORDERVIEW_IT_MONGO is set (plain standalone mongod), e.g. ORDERVIEW_IT_MONGO="mongodb://127.0.0.1:27096".
 * Creates a throw-away database and drops it. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Model } from 'mongoose';
import { applySellerOrderView } from './seller-order-view.util';

const URI = process.env.ORDERVIEW_IT_MONGO;
const d = URI ? describe : describe.skip;

d('seller order views on a real MongoDB', () => {
  let conn: Connection;
  let orders: Model<any>;

  const mk = (n: string, status: string, isPaid: boolean, extra: any = {}, storeId = 'S1') =>
    orders.create({ n, isDelete: false, isPaid, sellerOrders: [{ storeId, status, items: [] }], ...extra });

  const run = async (view: unknown, storeId = 'S1') => {
    const matchFilter: any = { isDelete: false, 'sellerOrders.storeId': { $in: [storeId] } };
    const subFilter: any = { storeId: { $in: [storeId] } };
    applySellerOrderView(view, matchFilter, subFilter);
    if (Object.keys(subFilter).length > 1) matchFilter.sellerOrders = { $elemMatch: subFilter };
    const rows = await orders.find(matchFilter).lean();
    return rows.map((r: any) => r.n).sort();
  };

  beforeAll(async () => {
    conn = await mongoose.createConnection(`${URI}/orders_view_it`).asPromise();
    orders = conn.model('OrderViewIt', new mongoose.Schema({}, { strict: false }), 'orders');
    await orders.deleteMany({});
    await mk('pending-unpaid', 'pending', false);
    await mk('processing-paid', 'processing', true);
    await mk('shipped-unpaid', 'shipped', false);
    await mk('delivered-paid', 'delivered', true);
    await mk('cancelled-unpaid', 'cancelled', false);
    await mk('cod-awaiting', 'pending', false, { codProtection: { confirmation: { status: 'awaiting' } } });
    await mk('cod-confirmed', 'processing', false, { codProtection: { confirmation: { status: 'confirmed' } } });
    await mk('other-store', 'pending', false, {}, 'S2');
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('no view = every order of the store', async () => {
    expect(await run('')).toHaveLength(7);
  });

  it('unfulfilled = pending + processing only', async () => {
    expect(await run('unfulfilled')).toEqual(['cod-awaiting', 'cod-confirmed', 'pending-unpaid', 'processing-paid']);
  });

  it('open also includes shipped, never delivered or cancelled', async () => {
    expect(await run('open')).toEqual(['cod-awaiting', 'cod-confirmed', 'pending-unpaid', 'processing-paid', 'shipped-unpaid']);
  });

  it('unpaid excludes paid and cancelled orders', async () => {
    expect(await run('unpaid')).toEqual(['cod-awaiting', 'cod-confirmed', 'pending-unpaid', 'shipped-unpaid']);
  });

  it('cod_awaiting only returns orders waiting for the buyer to confirm', async () => {
    expect(await run('cod_awaiting')).toEqual(['cod-awaiting']);
  });

  it('never leaks another store and ignores unknown / non-string views', async () => {
    expect(await run('unpaid', 'S2')).toEqual(['other-store']);
    expect(await run('bogus')).toHaveLength(7);
    expect(await run({ $ne: null })).toHaveLength(7);
    expect(await run(['unpaid'])).toHaveLength(7);
  });
});
