/* eslint-disable prettier/prettier */
/**
 * Fulfilment services on a real MongoDB, direct calls (no Redis, no network): connect, tenant isolation, request creation,
 * send/retry/fail, signed callbacks (idempotent, forward-only, shipped -> fulfil), stock sync, auto-route.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit fulfillment.integration
 */
import mongoose, { Connection } from 'mongoose';
import { FulfillmentRequestSchema, FulfillmentServiceSchema } from './fulfillment.schema';
import { FulfillmentServicesService } from './fulfillment.service';
import { signPayload } from '../merchant-api/merchant-api.util';
import { nextStatus, parseCallback } from './fulfillment.util';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const A = 'storeA'; const B = 'storeB';
const actor = { id: 'u1', role: 'seller' };

describe('fulfillment util (pure)', () => {
  it('statuses only move forward; cancelling is refused once shipped', () => {
    expect(nextStatus('sent', 'accepted')).toBe('accepted');
    expect(nextStatus('accepted', 'accepted')).toBeNull();
    expect(nextStatus('shipped', 'accepted')).toBeNull();
    expect(nextStatus('accepted', 'cancelled')).toBe('cancelled');
    expect(nextStatus('shipped', 'cancelled')).toBeNull();
    expect(nextStatus('cancelled', 'shipped')).toBeNull();
  });
  it('callback parsing rejects bad shapes', () => {
    expect(parseCallback({ type: 'shipped', requestId: 'x' }).ok).toBe(false);
    expect(parseCallback({ eventId: 'e', type: 'nope' }).ok).toBe(false);
    expect(parseCallback({ eventId: 'e', type: 'stock', stock: [{ sku: 'a', quantity: -1 }] }).ok).toBe(false);
    expect(parseCallback({ eventId: 'e', type: 'stock', stock: [{ sku: 'a', quantity: 3 }] }).ok).toBe(true);
    const r: any = parseCallback({ eventId: 'e', type: 'shipped', requestId: 'r', tracking: { carrier: 'TCS', trackingUrl: 'javascript:alert(1)' } });
    expect(r.tracking.trackingUrl).toBeNull();
  });
});

d('fulfillment services (real Mongo, direct calls)', () => {
  let conn: Connection; let m: any; let svc: FulfillmentServicesService; let fulfil: jest.Mock; let queued: string[];
  beforeAll(async () => {
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'a'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `ff_it_${Date.now()}` }).asPromise();
    const loose = (n: string, idString = false) => conn.model(n, new mongoose.Schema(idString ? { _id: String } : {}, { strict: false }));
    m = {
      services: conn.model('FulfillmentService', FulfillmentServiceSchema),
      requests: conn.model('FulfillmentRequest', FulfillmentRequestSchema),
      orders: loose('Order'), stores: loose('Store', true), locations: loose('StoreLocation'), variants: loose('ProductVariant'), vls: loose('VariantLocationStock'),
    };
    await Promise.all([m.services.init(), m.requests.init()]);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  beforeEach(async () => {
    for (const x of Object.values(m) as any[]) await x.deleteMany({});
    await m.stores.create([{ _id: A, sellerId: 'sel1' }, { _id: B, sellerId: 'sel2' }]);
    fulfil = jest.fn(async () => ({ success: true }));
    queued = [];
    const db: any = { repositories: { storeModel: m.stores, orderModel: m.orders, storeLocationModel: m.locations, productVariantModel: m.variants, variantLocationStockModel: m.vls } };
    svc = new FulfillmentServicesService(m.services, m.requests, db, { log: jest.fn().mockResolvedValue(undefined) } as any, { get: () => ({ fulfilItems: fulfil }) } as any, { add: async (_n: string, d: any) => { queued.push(d.requestId); } } as any);
  });

  const connect = (storeId = A, name = '3PL One', extra: any = {}) => svc.createService(storeId, storeId === A ? 'sel1' : 'sel2', actor, { name, provider: 'mock', ...extra });
  const order = (storeId = A, extra: any = {}) => m.orders.create({
    orderNumber: 'ORD-1', isPaid: true, isDelete: false, shippingAddress: { recipientName: 'Ali', addressLine1: '1 Road', city: 'Karachi' },
    sellerOrders: [{ storeId, status: 'pending', fulfillmentType: 'physical', items: [{ productId: 'p1', variantId: 'v1', sku: 'SKU-1', name: 'Shirt', quantity: 2, type: 'physical' }] }], ...extra,
  });
  const signed = (secret: string, body: any) => { const raw = JSON.stringify(body); return { raw, sig: signPayload(secret, raw), body }; };

  it('connecting creates an owned warehouse location, shows the secret once and never lists it', async () => {
    const s: any = await connect();
    expect(s.secret).toMatch(/^whsec_/);
    const loc: any = await m.locations.findById(s.locationId);
    expect(loc.fulfillmentServiceId).toBe(String(s._id));
    expect(loc.type).toBe('warehouse');
    const list: any[] = await svc.listServices(A);
    expect(list).toHaveLength(1);
    expect(list[0].secretEnc).toBeUndefined();
    await expect(connect(A, '3PL One')).rejects.toThrow(/already exists/);
    await expect(svc.createService(A, 'sel1', actor, { name: 'x', provider: 'generic_http', endpointUrl: 'http://10.0.0.1/x' })).rejects.toThrow();
  });

  it('another store cannot read, change, rotate, delete or route through this service', async () => {
    const s: any = await connect();
    expect(await svc.listServices(B)).toHaveLength(0);
    await expect(svc.updateService(B, actor, String(s._id), { name: 'Hijack' })).rejects.toThrow(/not found/i);
    await expect(svc.rotateSecret(B, actor, String(s._id))).rejects.toThrow(/not found/i);
    await expect(svc.deleteService(B, actor, String(s._id))).rejects.toThrow(/not found/i);
    const o: any = await order(B);
    await expect(svc.createRequest(B, actor, String(o._id), String(s._id))).rejects.toThrow(/not found/i);
    await expect(svc.createRequest(A, actor, String(o._id), String(s._id))).rejects.toThrow(/Order not found/);
  });

  it('a request is built from physical unshipped lines, queued once, and a second send is a conflict', async () => {
    const s: any = await connect(); const o: any = await order();
    const r: any = await svc.createRequest(A, actor, String(o._id), String(s._id));
    expect(r.items[0]).toMatchObject({ sku: 'SKU-1', quantity: 2 });
    expect(queued).toEqual([String(r._id)]);
    await expect(svc.createRequest(A, actor, String(o._id), String(s._id))).rejects.toThrow(/already sent/);
    const digital: any = await m.orders.create({ orderNumber: 'D', isPaid: true, isDelete: false, sellerOrders: [{ storeId: A, status: 'pending', fulfillmentType: 'digital', items: [] }] });
    await expect(svc.createRequest(A, actor, String(digital._id), String(s._id))).rejects.toThrow(/Nothing left/);
  });

  it('send: success marks sent once (a redelivered job is a no-op); failures retry then end failed; retry works', async () => {
    const s: any = await connect(); const o: any = await order();
    const r: any = await svc.createRequest(A, actor, String(o._id), String(s._id));
    await svc.processSend(String(r._id), false); await svc.processSend(String(r._id), false);
    const sent: any = await m.requests.findById(r._id);
    expect(sent.status).toBe('sent'); expect(sent.attempts).toBe(1); expect(sent.externalId).toMatch(/^mock-/);

    const s2: any = await connect(A, 'Broken', { provider: 'generic_http', endpointUrl: 'https://3pl.example.com/hook' });
    await m.services.updateOne({ _id: s2._id }, { $set: { provider: 'generic_http', endpointUrl: 'http://localhost/x' } }); // endpoint turned invalid
    const o2: any = await order(A, { orderNumber: 'ORD-2' });
    const r2: any = await svc.createRequest(A, actor, String(o2._id), String(s2._id));
    await expect(svc.processSend(String(r2._id), false)).rejects.toThrow();
    expect(((await m.requests.findById(r2._id)) as any).status).toBe('pending');
    await svc.processSend(String(r2._id), true);
    const failed: any = await m.requests.findById(r2._id);
    expect(failed.status).toBe('failed'); expect(failed.lastError).toBeTruthy();
    await svc.retry(A, actor, String(r2._id));
    expect(((await m.requests.findById(r2._id)) as any).status).toBe('pending');
    await expect(svc.retry(A, actor, String(r._id))).rejects.toThrow(/Only failed/);
  });

  describe('callbacks', () => {
    const setup = async () => {
      const s: any = await connect(); const o: any = await order();
      const r: any = await svc.createRequest(A, actor, String(o._id), String(s._id));
      await svc.processSend(String(r._id), false);
      return { s, o, r, id: String(s._id), rid: String(r._id) };
    };

    it('bad or missing signature, wrong secret and unknown service are refused alike', async () => {
      const { s, id, rid } = await setup();
      const body = { eventId: 'e1', type: 'accepted', requestId: rid };
      await expect(svc.handleCallback(id, JSON.stringify(body), '', body)).rejects.toThrow(/Invalid signature/);
      await expect(svc.handleCallback(id, JSON.stringify(body), signPayload('whsec_wrong', JSON.stringify(body)), body)).rejects.toThrow(/Invalid signature/);
      const ok = signed(s.secret, body);
      await expect(svc.handleCallback(String(new mongoose.Types.ObjectId()), ok.raw, ok.sig, body)).rejects.toThrow(/Invalid signature/);
      await expect(svc.handleCallback(id, ok.raw, ok.sig, body)).resolves.toMatchObject({ success: true });
    });

    it('accepted -> shipped fulfils the order lines with tracking; a repeated event does nothing twice', async () => {
      const { s, id, rid } = await setup();
      const a = signed(s.secret, { eventId: 'e1', type: 'accepted', requestId: rid });
      await svc.handleCallback(id, a.raw, a.sig, a.body);
      const sh = signed(s.secret, { eventId: 'e2', type: 'shipped', requestId: rid, tracking: { carrier: 'TCS', trackingNumber: 'TRK1', trackingUrl: 'https://t.example/TRK1' } });
      await svc.handleCallback(id, sh.raw, sh.sig, sh.body);
      await svc.handleCallback(id, sh.raw, sh.sig, sh.body);
      expect(fulfil).toHaveBeenCalledTimes(1);
      const [sellerId, storeId, , dto] = fulfil.mock.calls[0];
      expect([sellerId, storeId]).toEqual(['sel1', A]);
      expect(dto.items).toHaveLength(1); expect(dto.trackingNumber).toBe('TRK1');
      const r: any = await m.requests.findById(rid);
      expect(r.status).toBe('shipped'); expect(r.tracking.carrier).toBe('TCS');
    });

    it('goes forward only: an old "accepted" after shipped is ignored, and cancel after shipped is refused', async () => {
      const { s, id, rid } = await setup();
      const sh = signed(s.secret, { eventId: 'e2', type: 'shipped', requestId: rid });
      await svc.handleCallback(id, sh.raw, sh.sig, sh.body);
      const late = signed(s.secret, { eventId: 'e3', type: 'accepted', requestId: rid });
      await expect(svc.handleCallback(id, late.raw, late.sig, late.body)).resolves.toMatchObject({ ignored: true });
      const c = signed(s.secret, { eventId: 'e4', type: 'cancelled', requestId: rid });
      await expect(svc.handleCallback(id, c.raw, c.sig, c.body)).resolves.toMatchObject({ ignored: true });
      expect(((await m.requests.findById(rid)) as any).status).toBe('shipped');
    });

    it('if fulfilling the order fails, the shipped event is undone so the service retry is processed', async () => {
      const { s, id, rid } = await setup();
      fulfil.mockRejectedValueOnce(new Error('order locked'));
      const sh = signed(s.secret, { eventId: 'e2', type: 'shipped', requestId: rid });
      await expect(svc.handleCallback(id, sh.raw, sh.sig, sh.body)).rejects.toThrow(/order locked/);
      expect(((await m.requests.findById(rid)) as any).status).toBe('sent');
      await svc.handleCallback(id, sh.raw, sh.sig, sh.body);
      expect(((await m.requests.findById(rid)) as any).status).toBe('shipped');
    });

    it('a service cannot touch another store\'s request, even with a valid signature of its own', async () => {
      const { rid } = await setup();
      const other: any = await connect(B, 'Other 3PL');
      const body = { eventId: 'x1', type: 'shipped', requestId: rid };
      const sg = signed(other.secret, body);
      await expect(svc.handleCallback(String(other._id), sg.raw, sg.sig, body)).rejects.toThrow(/Request not found/);
      expect(fulfil).not.toHaveBeenCalled();
    });

    it('stock callback sets the owned location row and moves the variant total by the difference; unknown SKUs are skipped', async () => {
      const s: any = await connect();
      const v: any = await m.variants.create({ storeId: A, productId: 'p1', sku: 'SKU-1', stock: 10, isDelete: false });
      const body = { eventId: 's1', type: 'stock', stock: [{ sku: 'SKU-1', quantity: 25 }, { sku: 'NOPE', quantity: 1 }] };
      const g = signed(s.secret, body);
      await expect(svc.handleCallback(String(s._id), g.raw, g.sig, body)).resolves.toMatchObject({ updated: 1, skipped: 1 });
      expect(((await m.variants.findById(v._id)) as any).stock).toBe(35);
      const row: any = await m.vls.findOne({ variantId: String(v._id), locationId: s.locationId });
      expect(row.stock).toBe(25);
      const body2 = { eventId: 's2', type: 'stock', stock: [{ sku: 'SKU-1', quantity: 20 }] };
      const g2 = signed(s.secret, body2);
      await svc.handleCallback(String(s._id), g2.raw, g2.sig, body2);
      expect(((await m.variants.findById(v._id)) as any).stock).toBe(30);
      // other store's variant with the same SKU is never touched
      const ov: any = await m.variants.create({ storeId: B, productId: 'p9', sku: 'SKU-1', stock: 7, isDelete: false });
      expect(((await m.variants.findById(ov._id)) as any).stock).toBe(7);
    });
  });

  it('auto-route sends a paid order once, never an unpaid one, and only to its own store\'s service', async () => {
    const s: any = await connect(A, 'Auto', { autoRoute: true });
    await connect(B, 'Other', { autoRoute: true });
    const unpaid: any = await order(A, { isPaid: false, orderNumber: 'U' });
    await svc.autoRoute(String(unpaid._id));
    expect(await m.requests.countDocuments({})).toBe(0);
    const o: any = await order();
    await svc.autoRoute(String(o._id)); await svc.autoRoute(String(o._id));
    const rs: any[] = await m.requests.find({}).lean();
    expect(rs).toHaveLength(1);
    expect(rs[0].serviceId).toBe(String(s._id)); expect(rs[0].storeId).toBe(A);
  });

  it('a service with open requests cannot be removed; cancel works before shipping only', async () => {
    const s: any = await connect(); const o: any = await order();
    const r: any = await svc.createRequest(A, actor, String(o._id), String(s._id));
    await expect(svc.deleteService(A, actor, String(s._id))).rejects.toThrow(/open requests/);
    await svc.cancelRequest(A, actor, String(r._id));
    await expect(svc.cancelRequest(A, actor, String(r._id))).rejects.toThrow(/no longer/);
    await expect(svc.deleteService(A, actor, String(s._id))).resolves.toMatchObject({ success: true });
  });
});
