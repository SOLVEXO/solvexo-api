/* eslint-disable prettier/prettier */
/** Webhook signing/retry rules + token scoping (pure) and delivery/tokens on a real MongoDB (skipped without MONGO_TEST_URI). */
import mongoose, { Connection } from 'mongoose';
import { promises as dnsPromises } from 'dns';
import { MAX_ATTEMPTS, AUTO_DISABLE_AFTER, generateToken, hashToken, makeRateLimiter, nextDelayMs, scopeAllows, signPayload, validEvents, validScopes, validateWebhookUrl, verifySignature } from './merchant-api.util';
import { ApiTokenSchema, WebhookDeliverySchema, WebhookSubscriptionSchema } from './merchant-api.schema';
import { MerchantWebhooksService } from './merchant-webhooks.service';
import { ApiTokenGuard, ApiTokensService } from './api-tokens.service';

describe('signature', () => {
  it('verifies, and rejects a changed body, a wrong secret, a bad header and an old timestamp', () => {
    const h = signPayload('s3cret', '{"a":1}', 1000);
    expect(verifySignature('s3cret', '{"a":1}', h, 1000)).toBe(true);
    expect(verifySignature('s3cret', '{"a":2}', h, 1000)).toBe(false);
    expect(verifySignature('other', '{"a":1}', h, 1000)).toBe(false);
    expect(verifySignature('s3cret', '{"a":1}', 'garbage', 1000)).toBe(false);
    expect(verifySignature('s3cret', '{"a":1}', h, 1000 + 301)).toBe(false);
    expect(verifySignature('s3cret', '{"a":1}', h, 1000 + 299)).toBe(true);
  });
});

describe('rules', () => {
  it('retries back off and then give up', () => {
    expect(nextDelayMs(1)).toBe(60_000); expect(nextDelayMs(2)).toBe(300_000); expect(nextDelayMs(MAX_ATTEMPTS)).toBeNull();
  });
  it('webhook urls must be https public domain names', () => {
    expect(validateWebhookUrl('https://hooks.example.com/x')).toBeNull();
    for (const bad of ['http://a.com', 'https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://u:p@a.com', 'https://a.com:8443', 'https://intranet/x', 'nope']) expect(validateWebhookUrl(bad)).not.toBeNull();
  });
  it('only known events and scopes', () => {
    expect(validEvents(['order.paid'])).toEqual(['order.paid']); expect(validEvents(['nope'])).toBeNull(); expect(validEvents([])).toBeNull();
    expect(validScopes(['read_orders'])).toEqual(['read_orders']); expect(validScopes(['admin'])).toBeNull();
  });
  it('a write scope implies the read of the same resource, not other resources', () => {
    expect(scopeAllows(['write_orders'], 'read_orders')).toBe(true);
    expect(scopeAllows(['read_orders'], 'write_orders')).toBe(false);
    expect(scopeAllows(['read_orders'], 'read_products')).toBe(false);
  });
  it('tokens are hashed, prefixed and unique', () => {
    const a = generateToken(); const b = generateToken();
    expect(a.token).toMatch(/^sxk_[0-9a-f]{40}$/); expect(a.hash).toBe(hashToken(a.token)); expect(a.hash).not.toBe(b.hash); expect(a.hash).not.toContain(a.token);
  });
  it('rate limiter allows the limit then blocks until the window resets', () => {
    const l = makeRateLimiter(2, 1000);
    expect([l('k', 0), l('k', 1), l('k', 2), l('k', 1001)]).toEqual([true, true, false, true]);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('webhooks and tokens on a real MongoDB', () => {
  jest.setTimeout(60000);
  let conn: Connection; let svc: MerchantWebhooksService; let tokens: ApiTokensService; let orders: any;
  const actor = { id: 'u1', role: 'seller' };
  const S1 = 'store1'; const S2 = 'store2';
  let fetchMock: jest.Mock; const realFetch = global.fetch;

  beforeAll(async () => {
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'a'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `merchant_it_${Date.now()}` }).asPromise();
    const subs = conn.model('WebhookSubscription', WebhookSubscriptionSchema); const dels = conn.model('WebhookDelivery', WebhookDeliverySchema); const tk = conn.model('ApiToken', ApiTokenSchema);
    await Promise.all([subs.init(), dels.init(), tk.init()]);
    orders = conn.model('Order', new mongoose.Schema({}, { strict: false }));
    const log = { log: async () => undefined } as any;
    svc = new MerchantWebhooksService(subs as any, dels as any, { repositories: { orderModel: orders } } as any, log);
    tokens = new ApiTokensService(tk as any, log);
  });
  afterAll(async () => { global.fetch = realFetch; await conn?.dropDatabase(); await conn?.close(); });
  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ status: 200 })); (global as any).fetch = fetchMock;
    jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
  });
  afterEach(() => jest.restoreAllMocks());
  const mk = async (store: string, events = ['order.paid']) => { const c = await svc.create(store, actor, { url: 'https://hooks.example.com/in', events }); return c; };
  const settle = () => new Promise((r) => setTimeout(r, 250)); // emit() starts the first attempt in the background
  const deliveriesOf = async (store: string) => conn.model('WebhookDelivery').find({ storeId: store }).lean() as any;

  it('a delivery is signed with the store secret, sent once per event, and recorded as success', async () => {
    const c = await mk(S1);
    await svc.emit(S1, 'order.paid', { order_id: 'o1' }, 'order.paid:o1');
    await svc.emit(S1, 'order.paid', { order_id: 'o1' }, 'order.paid:o1'); // same event again: ignored
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(verifySignature(c.secret, init.body, init.headers['X-Solvexo-Signature'])).toBe(true);
    expect(init.redirect).toBe('manual'); expect(init.headers['X-Solvexo-Delivery']).toBe('order.paid:o1');
    expect(((await deliveriesOf(S1)) as any[])[0].status).toBe('success');
    expect(((await deliveriesOf(S1)) as any[])).toHaveLength(1);
  });

  it('events are only delivered to subscriptions of the same store and of that event', async () => {
    await mk(S2, ['product.updated']);
    await svc.emit(S2, 'order.paid', { order_id: 'x' }, 'order.paid:x');
    expect(await deliveriesOf(S2)).toHaveLength(0);
    await svc.emit(S2, 'product.updated', { id: 'p' }, 'product.updated:p:1');
    expect(await deliveriesOf(S2)).toHaveLength(1);
  });

  it('a failure is retried later with backoff; the 6th failure ends it and counts toward auto-disable', async () => {
    const store = 'storeRetry'; const c = await mk(store);
    fetchMock.mockResolvedValue({ status: 500 });
    await svc.emit(store, 'order.paid', {}, 'order.paid:r1');
    await settle();
    const [dl] = await deliveriesOf(store);
    let cur: any = (await deliveriesOf(store))[0];
    expect(cur.status).toBe('pending'); expect(cur.attempts).toBe(1); expect(new Date(cur.nextAttemptAt).getTime()).toBeGreaterThan(Date.now() + 50_000);
    for (let i = 1; i < MAX_ATTEMPTS; i++) { await conn.model('WebhookDelivery').updateOne({ _id: dl._id }, { $set: { nextAttemptAt: new Date() } }); await svc.attempt(String(dl._id)); }
    cur = (await deliveriesOf(store))[0];
    expect(cur.status).toBe('failed'); expect(cur.attempts).toBe(MAX_ATTEMPTS); expect(cur.error).toMatch(/500/);
    expect(((await conn.model('WebhookSubscription').findById(c.id).lean()) as any).consecutiveFailures).toBe(1);
  });

  it('a subscription is switched off after repeated failed deliveries', async () => {
    const store = 'storeAuto'; const c = await mk(store);
    await conn.model('WebhookSubscription').updateOne({ _id: c.id }, { $set: { consecutiveFailures: AUTO_DISABLE_AFTER - 1 } });
    fetchMock.mockResolvedValue({ status: 500 });
    await svc.emit(store, 'order.paid', {}, 'order.paid:a1');
    await settle();
    const [dl] = await deliveriesOf(store);
    await conn.model('WebhookDelivery').updateOne({ _id: dl._id }, { $set: { attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date() } });
    await svc.attempt(String(dl._id));
    const sub: any = await conn.model('WebhookSubscription').findById(c.id).lean();
    expect(sub.enabled).toBe(false); expect(sub.disabledReason).toMatch(/failed deliveries/);
  });

  it('refuses a receiver that resolves to a private address', async () => {
    const store = 'storePriv'; await mk(store);
    (dnsPromises.lookup as jest.Mock).mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await svc.emit(store, 'order.paid', {}, 'order.paid:p1');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(((await deliveriesOf(store)) as any[])[0].error).toMatch(/private network/);
  });

  it('manual redeliver re-queues a finished delivery of this store only; the secret rotates', async () => {
    const store = 'storeRe'; const c = await mk(store);
    await svc.emit(store, 'order.paid', {}, 'order.paid:z1');
    await settle();
    const [dl] = await deliveriesOf(store);
    await expect(svc.redeliver('someoneElse', actor, String(dl._id))).rejects.toThrow(/not found/);
    await svc.redeliver(store, actor, String(dl._id));
    await settle();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    const r = await svc.rotate(store, actor, c.id);
    expect(r.secret).not.toBe(c.secret);
  });

  it('an order change creates order.created / order.paid events once per store', async () => {
    const store = 'storeOrd'; await mk(store, ['order.created', 'order.paid']);
    const o: any = await orders.create({ createdAt: new Date(), isPaid: true, orderStatus: 'processing', orderNumber: '7', totalAmount: 50, currency: 'PKR', sellerOrders: [{ storeId: store }] });
    await svc.fromOrder(String(o._id)); await svc.fromOrder(String(o._id));
    await settle();
    expect((await deliveriesOf(store)).map((x: any) => x.event).sort()).toEqual(['order.created', 'order.paid']);
  });

  it('api tokens: shown once, stored hashed, scoped, revocable, store-isolated', async () => {
    const t = await tokens.create(S1, actor, { name: 'ERP', scopes: ['read_orders'] });
    const stored: any = await conn.model('ApiToken').findById(t.id).lean();
    expect(stored.tokenHash).toBe(hashToken(t.token)); expect(JSON.stringify(stored)).not.toContain(t.token);
    expect(JSON.stringify(await tokens.list(S1))).not.toContain(t.token);
    const guard = new ApiTokenGuard(tokens, { get: () => 'read_orders' } as any);
    const ctx = (auth: string, req: any = { headers: { authorization: auth } }) => ({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null }) as any;
    const req: any = { headers: { authorization: `Bearer ${t.token}` } };
    expect(await guard.canActivate(ctx('', req))).toBe(true); expect(req.apiToken.storeId).toBe(S1);
    await expect(new ApiTokenGuard(tokens, { get: () => 'read_products' } as any).canActivate(ctx('', { headers: { authorization: `Bearer ${t.token}` } }))).rejects.toThrow(/permission/);
    await expect(guard.canActivate(ctx('Bearer sxk_' + 'a'.repeat(40)))).rejects.toThrow(/Invalid/);
    await expect(guard.canActivate(ctx('Bearer nope'))).rejects.toThrow(/malformed/);
    await expect(tokens.revoke(S2, actor, t.id)).rejects.toThrow(/not found/);
    await tokens.revoke(S1, actor, t.id);
    await expect(guard.canActivate(ctx('', { headers: { authorization: `Bearer ${t.token}` } }))).rejects.toThrow(/Invalid/);
  });
});
