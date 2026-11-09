/* eslint-disable prettier/prettier */
/** P8 gaps: product / inventory / customer / refund webhooks, and write endpoints (scope, idempotency, isolation, audit). Real Mongo, skipped without MONGO_TEST_URI. */
import mongoose, { Connection, Types } from 'mongoose';
import { promises as dnsPromises } from 'dns';
import { productUpdateMatters, stockUpdateMatters } from '../common/resource-events';
import { verifySignature } from './merchant-api.util';
import { ApiIdempotencySchema, WebhookDeliverySchema, WebhookSubscriptionSchema } from './merchant-api.schema';
import { MerchantWebhooksService } from './merchant-webhooks.service';
import { ApiWritesService } from './api-writes.service';

describe('which writes count', () => {
  it('product: real edits yes, storefront counters no', () => {
    expect(productUpdateMatters({ $set: { name: 'x' } })).toBe(true);
    expect(productUpdateMatters({ $set: { status: 'inactive' } })).toBe(true);
    expect(productUpdateMatters({ $inc: { viewCount: 1 } })).toBe(false);
    expect(productUpdateMatters({ $inc: { wishlistCount: 1 }, $set: { averageRating: 4.5, totalRatings: 3 } })).toBe(false);
    expect(productUpdateMatters({ $set: { 'seo.title': 'x' } })).toBe(true);
  });
  it('variant: stock fields yes (also pipeline updates), price no', () => {
    expect(stockUpdateMatters({ $inc: { stock: -1 } })).toBe(true);
    expect(stockUpdateMatters({ $set: { committedStock: 2 } })).toBe(true);
    expect(stockUpdateMatters([{ $set: { stock: { $max: [0, { $subtract: ['$stock', 1] }] } } }])).toBe(true);
    expect(stockUpdateMatters({ $set: { price: 10 } })).toBe(false);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('resource webhooks + API writes on a real MongoDB', () => {
  jest.setTimeout(60000);
  let conn: Connection; let hooks: MerchantWebhooksService; let writes: ApiWritesService; let M: Record<string, any>;
  const actor = { id: 'u1', role: 'seller' };
  const A = new Types.ObjectId().toHexString(); const B = new Types.ObjectId().toHexString();
  let fetchMock: jest.Mock; const realFetch = global.fetch; const audit = jest.fn(async () => undefined); const adjust = jest.fn(async () => ({ data: { balance: 1 } }));
  const settle = () => new Promise((r) => setTimeout(r, 700));
  const deliveries = async (store: string) => conn.model('WebhookDelivery').find({ storeId: store }).lean() as any;
  const mk = (store: string, events: string[]) => hooks.create(store, actor, { url: 'https://hooks.example.com/in', events });

  beforeAll(async () => {
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'a'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `mgaps_it_${Date.now()}` }).asPromise();
    const loose = (n: string) => conn.model(n, new mongoose.Schema({}, { strict: false }));
    M = { productModel: loose('Product'), productVariantModel: loose('Variant'), userModel: loose('User'), orderModel: loose('Order'), storeModel: loose('Store') };
    const subs = conn.model('WebhookSubscription', WebhookSubscriptionSchema); const dels = conn.model('WebhookDelivery', WebhookDeliverySchema); const idem = conn.model('ApiIdempotency', ApiIdempotencySchema);
    await Promise.all([subs.init(), dels.init(), idem.init()]);
    const db: any = { repositories: M }; const act: any = { log: audit };
    hooks = new MerchantWebhooksService(subs as any, dels as any, db, act);
    writes = new ApiWritesService(idem as any, db, act, { adjustStock: adjust } as any);
  });
  afterAll(async () => { global.fetch = realFetch; await conn?.dropDatabase(); await conn?.close(); });
  beforeEach(() => { fetchMock = jest.fn(async () => ({ status: 200 })); (global as any).fetch = fetchMock; jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any); audit.mockClear(); adjust.mockClear(); });
  afterEach(() => jest.restoreAllMocks());

  it('product.updated goes to the product\'s own store only, once per burst, signed', async () => {
    const sa = await mk(A, ['product.updated']); await mk(B, ['product.updated']);
    const p: any = await M.productModel.create({ storeId: A, name: 'Shirt', slug: 'shirt', status: 'active', isDelete: false });
    await hooks.fromResource({ kind: 'product', id: String(p._id), created: false });
    await hooks.fromResource({ kind: 'product', id: String(p._id), created: false });
    await settle();
    expect(await deliveries(B)).toHaveLength(0);
    const list = await deliveries(A); expect(list).toHaveLength(1); expect(list[0].event).toBe('product.updated');
    expect(JSON.parse(list[0].payload).data).toMatchObject({ product_id: String(p._id), name: 'Shirt', status: 'active' });
    const [, init] = fetchMock.mock.calls[0];
    expect(verifySignature(sa.secret, init.body, init.headers['X-Solvexo-Signature'])).toBe(true);
  });

  it('inventory.changed carries on-hand / committed / available, routed by the variant\'s store', async () => {
    await mk(A, ['inventory.changed']);
    const v: any = await M.productVariantModel.create({ storeId: A, productId: 'p', sku: 'S1', stock: 10, committedStock: 3 });
    await hooks.fromResource({ kind: 'variant_stock', id: String(v._id), created: false }); await settle();
    const e = (await deliveries(A)).find((x: any) => x.event === 'inventory.changed');
    expect(JSON.parse(e.payload).data).toMatchObject({ variant_id: String(v._id), on_hand: 10, committed: 3, available: 7, sku: 'S1' });
  });

  it('customer.created: a store customer yes, a guest session no, another store no', async () => {
    await mk(B, ['customer.created']);
    const u: any = await M.userModel.create({ storeId: B, name: 'Ali', email: 'a@b.com' });
    const g: any = await M.userModel.create({ storeId: B, name: 'G', email: 'g@x.com', isGuest: true });
    await hooks.fromResource({ kind: 'customer', id: String(u._id), created: true });
    await hooks.fromResource({ kind: 'customer', id: String(g._id), created: true }); await settle();
    const list = (await deliveries(B)).filter((x: any) => x.event === 'customer.created');
    expect(list).toHaveLength(1); expect(JSON.parse(list[0].payload).data.email).toBe('a@b.com');
  });

  it('refund.created fires for each refunded amount (partial then full) and not twice for the same amount', async () => {
    const store = new Types.ObjectId().toHexString(); await mk(store, ['refund.created']);
    const o: any = await M.orderModel.create({ orderStatus: 'delivered', isPaid: true, totalAmount: 100, currency: 'PKR', sellerOrders: [{ storeId: store, refundedTotal: 20 }] });
    await hooks.fromOrder(String(o._id)); await hooks.fromOrder(String(o._id));
    await M.orderModel.updateOne({ _id: o._id }, { $set: { 'sellerOrders.0.refundedTotal': 50 } });
    await hooks.fromOrder(String(o._id)); await settle();
    const list = (await deliveries(store)).filter((x: any) => x.event === 'refund.created');
    expect(list.map((x: any) => JSON.parse(x.payload).data.refunded_total).sort()).toEqual([20, 50]);
  });

  describe('write endpoints', () => {
    const callerA = { id: 'tokA', storeId: A }; const callerB = { id: 'tokB', storeId: B };
    it('needs an Idempotency-Key; one effect per key; a retry returns the stored answer', async () => {
      const p: any = await M.productModel.create({ storeId: A, name: 'W', status: 'active', isDelete: false, tags: [] });
      await expect(writes.once(callerA, undefined, {}, async () => 1)).rejects.toThrow(/Idempotency-Key/);
      let runs = 0; const run = () => writes.once(callerA, 'key-123456', { id: String(p._id), s: 'inactive' }, async () => { runs++; return writes.updateProduct(callerA, String(p._id), { status: 'inactive' }); });
      const [r1, r2] = await Promise.allSettled([run(), (async () => { await settle(); return run(); })()]);
      expect(r1.status).toBe('fulfilled'); expect(r2.status).toBe('fulfilled');
      expect((r2 as any).value.replayed).toBe(true); expect(runs).toBe(1);
      expect((await M.productModel.findById(p._id).lean() as any).status).toBe('inactive');
      await expect(writes.once(callerA, 'key-123456', { id: String(p._id), s: 'active' }, async () => 1)).rejects.toThrow(/different request/);
    });
    it('a failed attempt does not burn the key', async () => {
      await expect(writes.once(callerA, 'key-fail-001', { x: 1 }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      const ok = await writes.once(callerA, 'key-fail-001', { x: 1 }, async () => 'fine');
      expect(ok).toEqual({ replayed: false, result: 'fine' });
    });
    it('isolation: a token cannot write another store\'s product or variant', async () => {
      const pB: any = await M.productModel.create({ storeId: B, name: 'B only', status: 'active', isDelete: false });
      await expect(writes.updateProduct(callerA, String(pB._id), { status: 'inactive' })).rejects.toThrow(/not found/i);
      const vB: any = await M.productVariantModel.create({ storeId: B, productId: String(pB._id), sku: 'B1', stock: 1, isDelete: false });
      await expect(writes.adjustInventory(callerA, { variantId: String(vB._id), delta: 1 })).rejects.toThrow(/not found/i);
      expect(adjust).not.toHaveBeenCalled();
      expect((await M.productModel.findById(pB._id).lean() as any).status).toBe('active');
    });
    it('writes are validated (allow-list, delta rules) and audited as the token', async () => {
      const p: any = await M.productModel.create({ storeId: A, name: 'V', status: 'active', isDelete: false });
      await expect(writes.updateProduct(callerA, String(p._id), { name: 'hijack' })).rejects.toThrow(/status and\/or tags/);
      await expect(writes.updateProduct(callerA, String(p._id), { status: 'deleted' })).rejects.toThrow(/active or inactive/);
      await writes.updateProduct(callerA, String(p._id), { tags: ['a', 'a', ' b '] });
      expect((await M.productModel.findById(p._id).lean() as any).tags).toEqual(['a', 'b']);
      const own: any = await M.productVariantModel.create({ storeId: A, productId: String(p._id), sku: 'A1', stock: 5, isDelete: false });
      await expect(writes.adjustInventory(callerA, { variantId: String(own._id), delta: 0 })).rejects.toThrow(/whole number/);
      await expect(writes.adjustInventory(callerA, { variantId: String(own._id), delta: 1.5 })).rejects.toThrow(/whole number/);
      await expect(writes.adjustInventory(callerA, { variantId: String(own._id), delta: 99999 })).rejects.toThrow(/whole number/);
      await M.storeModel.create({ _id: A, sellerId: 'seller-a', isDelete: false });
      await writes.adjustInventory(callerA, { variantId: String(own._id), delta: 4, reason: 'restocked' });
      expect(adjust).toHaveBeenCalledWith('seller-a', A, String(own._id), 4, 'restocked', 'API adjustment');
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ storeId: A, actorId: 'tokA', actorRole: 'api_token', action: 'api_inventory_adjust' }));
      void callerB;
    });
  });
});
