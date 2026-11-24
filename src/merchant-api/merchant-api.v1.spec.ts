/* eslint-disable prettier/prettier */
/** Public API v1: paging rules, the OpenAPI contract, and store isolation / serializers / fulfil on a real MongoDB (skipped without MONGO_TEST_URI). */
import 'reflect-metadata';
import mongoose, { Connection, Types } from 'mongoose';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { ListQueryError, decodeCursor, encodeCursor, makeRateLimiterInfo, pageOf, parseListQuery, MAX_PAGE_SIZE } from './merchant-api.util';
import { buildOpenApiSpec } from './merchant-api.openapi';
import { MerchantApiV1Controller } from './merchant-api.controller';
import { ApiReadsService } from './api-reads.service';
import { ApiWritesService } from './api-writes.service';
import { ApiIdempotencySchema } from './merchant-api.schema';

describe('paging', () => {
  it('cursors round-trip and reject anything else', () => {
    const id = new Types.ObjectId().toHexString();
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    for (const bad of ['', 'abc', Buffer.from('v1:nope').toString('base64url'), Buffer.from(id).toString('base64url'), 42]) expect(decodeCursor(bad)).toBeNull();
  });
  it('limit, cursor and updated_since are checked', () => {
    expect(parseListQuery({})).toEqual({ limit: 50, afterId: null, updatedSince: null });
    expect(parseListQuery({ limit: '10', updated_since: '2026-11-01T00:00:00Z' }).updatedSince?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    for (const q of [{ limit: '0' }, { limit: String(MAX_PAGE_SIZE + 1) }, { limit: '2.5' }, { cursor: 'x' }, { updated_since: 'yesterday' }]) expect(() => parseListQuery(q)).toThrow(ListQueryError);
  });
  it('a page fetched with limit+1 says whether there is more and where to continue', () => {
    const rows = [1, 2, 3].map(() => ({ _id: new Types.ObjectId() }));
    const p = pageOf(rows, 2, (r) => String(r._id));
    expect(p.has_more).toBe(true); expect(p.items).toHaveLength(2); expect(decodeCursor(p.next_cursor)).toBe(String(rows[1]._id));
    expect(pageOf(rows.slice(0, 2), 2, (r) => r)).toMatchObject({ has_more: false, next_cursor: null });
  });
  it('the rate limiter reports what is left and when it resets', () => {
    const l = makeRateLimiterInfo(2, 60_000);
    expect(l('t', 0)).toEqual({ ok: true, limit: 2, remaining: 1, resetS: 60 });
    expect(l('t', 1000)).toMatchObject({ ok: true, remaining: 0, resetS: 59 });
    expect(l('t', 2000)).toMatchObject({ ok: false, remaining: 0 });
    expect(l('t', 60_000).ok).toBe(true);
  });
});

describe('OpenAPI contract', () => {
  const spec: any = buildOpenApiSpec('https://api.example.com');
  it('describes every route of the v1 controller, with the method it really has', () => {
    const proto = MerchantApiV1Controller.prototype as any;
    const routes = Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && Reflect.hasMetadata(PATH_METADATA, proto[k]))
      .map((k) => ({ path: `/${String(Reflect.getMetadata(PATH_METADATA, proto[k]))}`.replace(/:([a-z]+)/g, '{$1}'), method: RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[k])].toLowerCase() }));
    expect(routes.length).toBe(15);
    for (const r of routes) expect([r.path, r.method, !!spec.paths[r.path]?.[r.method]]).toEqual([r.path, r.method, true]);
    const described = Object.entries(spec.paths).flatMap(([p, ops]: any) => Object.keys(ops).map((m) => `${m} ${p}`));
    expect(described.sort()).toEqual(routes.map((r) => `${r.method} ${r.path}`).sort());
  });
  it('points at the API server, lists every scope and webhook, and every $ref resolves', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('https://api.example.com/api/merchant/v1');
    expect(Object.keys(spec.webhooks)).toContain('order.paid');
    const refs = JSON.stringify(spec).match(/#\/components\/schemas\/[A-Za-z]+/g) ?? [];
    for (const r of new Set(refs)) expect(spec.components.schemas[r.split('/').pop()!]).toBeDefined();
  });
  it('writes demand an Idempotency-Key and every operation has a unique id', () => {
    const ops = Object.values(spec.paths).flatMap((o: any) => Object.entries(o)) as [string, any][];
    // Changes to store data need a key; subscribing/unsubscribing a REST hook doesn't (Zapier and Make don't send one).
    for (const [m, op] of ops) if (m !== 'get' && !['createWebhook', 'deleteWebhook'].includes(op.operationId)) expect(op.parameters.some((p: any) => p.name === 'Idempotency-Key' && p.required)).toBe(true);
    const ids = ops.map(([, op]) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('v1 reads and fulfil on a real MongoDB', () => {
  jest.setTimeout(60000);
  let conn: Connection; let M: Record<string, any>; let reads: ApiReadsService; let writes: ApiWritesService;
  const fulfilItems = jest.fn(async () => ({ success: true }));
  const A = new Types.ObjectId().toHexString(); const B = new Types.ObjectId().toHexString();
  const SELLER = new Types.ObjectId().toHexString();
  const caller = { id: new Types.ObjectId().toHexString(), storeId: A };

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `mapiv1_it_${Date.now()}` }).asPromise();
    const loose = (n: string) => conn.model(n, new mongoose.Schema({}, { strict: false, timestamps: true }));
    M = {
      storeModel: loose('Store'), orderModel: loose('Order'), productModel: loose('Product'), productVariantModel: loose('Variant'),
      collectionModel: loose('Collection'), userModel: loose('User'), saleModel: loose('Sale'), storeCustomerMetaModel: loose('StoreCustomerMeta'),
    };
    const idem = conn.model('ApiIdempotency', ApiIdempotencySchema); await idem.init();
    const db: any = { repositories: M };
    reads = new ApiReadsService(db);
    writes = new ApiWritesService(idem as any, db, { log: jest.fn(async () => undefined) } as any, {} as any, { get: () => ({ fulfilItems }) } as any);
    await M.storeModel.create({ _id: A, sellerId: SELLER, name: 'Store A', slug: 'a', baseCurrency: 'PKR', timezone: 'Asia/Karachi', customDomain: 'shop.a.com', customDomainStatus: 'unverified', isDelete: false });
    await M.storeModel.create({ _id: B, sellerId: 'other', name: 'Store B', isDelete: false });
  });
  afterAll(async () => { await conn?.dropDatabase(); await conn?.close(); });

  const item = (over: any = {}) => ({ _id: new Types.ObjectId(), productId: 'p1', variantId: 'v1', name: 'Kurta', sku: 'K-1', type: 'physical', quantity: 2, price: 1500, totalPrice: 3000, options: [{ name: 'Size', value: 'M' }], costPrice: 900, ...over });

  it('store: its own, and an unverified domain is not shown', async () => {
    expect(await reads.store(A)).toEqual({ id: A, name: 'Store A', slug: 'a', currency: 'PKR', timezone: 'Asia/Karachi', domain: null, created_at: expect.any(String) });
  });

  it('orders: only this store\'s part of a marketplace order; order-wide amounts hidden', async () => {
    const buyer = new Types.ObjectId().toHexString();
    const mixed = await M.orderModel.create({
      orderNumber: 'SX-1', userId: buyer, currency: 'PKR', isPaid: true, paymentStatus: 'paid', totalAmount: 9999, shippingFee: 200, isDelete: false,
      shippingAddress: { recipientName: 'Ali', phoneNumber: '0300', addressLine1: 'St 1', city: 'Lahore', state: 'Punjab', zipCode: '54000', country: 'PK' },
      sellerOrders: [{ storeId: A, sellerId: SELLER, status: 'processing', subtotal: 3000, taxAmount: 0, items: [item()], shipments: [] }, { storeId: B, sellerId: 'other', status: 'processing', subtotal: 6999, items: [item({ name: 'Secret B item' })] }],
    });
    await M.orderModel.create({ orderNumber: 'SX-2', currency: 'PKR', isDelete: false, sellerOrders: [{ storeId: B, status: 'pending', items: [item()] }] });
    const page = await reads.orders(A, {});
    expect(page.items.map((o: any) => o.order_number)).toEqual(['SX-1']);
    const o: any = page.items[0];
    expect(o).toMatchObject({ id: String(mixed._id), status: 'processing', paid: true, subtotal: 3000, total: null, shipping: null, customer_id: buyer, shipping_address: { name: 'Ali', city: 'Lahore', province: 'Punjab' } });
    expect(o.line_items).toHaveLength(1);
    expect(JSON.stringify(o)).not.toContain('Secret B item');
    expect(JSON.stringify(o)).not.toContain('costPrice');
    expect(JSON.stringify(o)).not.toContain('900');
    await expect(reads.order(B, String(mixed._id))).resolves.toMatchObject({ subtotal: 6999 });
    const onlyB = await M.orderModel.findOne({ orderNumber: 'SX-2' }).lean();
    await expect(reads.order(A, String(onlyB._id))).rejects.toThrow('Order not found');
    await expect(reads.order(A, 'not-an-id')).rejects.toThrow('Order not found');
  });

  it('orders: cursor paging walks every order once; filters by status and updated_since', async () => {
    for (let i = 0; i < 5; i++) await M.orderModel.create({ orderNumber: `P-${i}`, currency: 'PKR', isPaid: i % 2 === 0, isDelete: false, sellerOrders: [{ storeId: A, status: i < 2 ? 'shipped' : 'pending', items: [item()] }] });
    const seen: string[] = []; let cursor: string | undefined; let rounds = 0;
    do { const p: any = await reads.orders(A, { limit: '2', cursor }); seen.push(...p.items.map((x: any) => x.order_number)); cursor = p.next_cursor ?? undefined; rounds++; } while (cursor && rounds < 10);
    expect(seen).toHaveLength(6); expect(new Set(seen).size).toBe(6);
    expect((await reads.orders(A, { status: 'shipped' })).items.map((x: any) => x.order_number).sort()).toEqual(['P-0', 'P-1']);
    expect((await reads.orders(A, { paid: 'false' })).items.every((x: any) => !x.paid)).toBe(true);
    expect((await reads.orders(A, { updated_since: new Date(Date.now() + 60_000).toISOString() })).items).toEqual([]);
    await expect(reads.orders(A, { status: 'bogus' })).rejects.toThrow('status must be one of');
    await expect(reads.orders(A, { limit: '500' })).rejects.toThrow('limit must be');
  });

  it('products: own store only, with variants and available stock', async () => {
    const p = await M.productModel.create({ storeId: A, name: 'Shirt', slug: 'shirt', status: 'active', tags: ['summer'], isDelete: false });
    await M.productModel.create({ storeId: B, name: 'B shirt', status: 'active', isDelete: false });
    await M.productModel.create({ storeId: A, name: 'Gone', status: 'active', isDelete: true });
    await M.productVariantModel.create({ productId: String(p._id), storeId: A, sku: 'S-M', price: 2500, stock: 10, committedStock: 3, damagedStock: 1, costPrice: 1000, isDelete: false, isDefault: true, options: [{ name: 'Size', value: 'M' }] });
    await M.productVariantModel.create({ productId: String(p._id), storeId: A, sku: 'S-L', price: 2500, unlimitedStock: true, isDelete: false });
    const list: any = await reads.products(A, {});
    expect(list.items.map((x: any) => x.name)).toEqual(['Shirt']);
    const v = list.items[0].variants;
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ sku: 'S-M', price: 2500, currency: 'PKR', inventory: { tracked: true, on_hand: 10, committed: 3, available: 6 } });
    expect(v[1].inventory).toMatchObject({ tracked: false, on_hand: null, available: null });
    expect(JSON.stringify(list)).not.toContain('costPrice');
    await expect(reads.product(B, String(p._id))).rejects.toThrow('Product not found');
    const inv: any = await reads.inventory(A, { product_id: String(p._id) });
    expect(inv.items.map((x: any) => x.sku).sort()).toEqual(['S-L', 'S-M']);
    await expect(reads.inventory(B, { product_id: String(p._id) })).rejects.toThrow('Product not found');
  });

  it('collections: own store; automatic ones have no stored member list', async () => {
    await M.collectionModel.create({ storeId: A, name: 'Summer', type: 'manual', productIds: ['p1'], status: 'active', isDelete: false });
    await M.collectionModel.create({ storeId: A, name: 'Sale', type: 'automatic', productIds: [], status: 'active', isDelete: false });
    await M.collectionModel.create({ storeId: B, name: 'B only', type: 'manual', isDelete: false });
    const c: any = await reads.collections(A, {});
    expect(c.items.map((x: any) => [x.name, x.product_ids])).toEqual([['Sale', null], ['Summer', ['p1']]]);
  });

  it('customers: only this store\'s, guests by their real email, consent per store, erased ones without personal data', async () => {
    const buyer = await M.userModel.create({ name: 'Sara', email: 'sara@example.com', phone: '0301', isGuest: false });
    const guest = await M.userModel.create({ name: 'Guest', email: 'g-123@guest.invalid', contactEmail: 'real@example.com', isGuest: true });
    const erased = await M.userModel.create({ name: 'Ahmed', email: 'ahmed@example.com', isGuest: false });
    const stranger = await M.userModel.create({ name: 'Other store buyer', email: 'x@example.com' });
    await M.orderModel.create({ userId: String(buyer._id), isDelete: false, sellerOrders: [{ storeId: A, items: [] }] });
    await M.orderModel.create({ userId: String(guest._id), isDelete: false, sellerOrders: [{ storeId: A, items: [] }] });
    await M.orderModel.create({ userId: String(stranger._id), isDelete: false, sellerOrders: [{ storeId: B, items: [] }] });
    await M.storeCustomerMetaModel.create({ storeId: A, userId: String(buyer._id), tags: ['vip'], marketingOptIn: true });
    await M.storeCustomerMetaModel.create({ storeId: B, userId: String(guest._id), marketingOptIn: true }); // consent at another store doesn't count
    await M.storeCustomerMetaModel.create({ storeId: A, userId: String(erased._id), isErased: true, tags: ['x'] });
    const list: any = await reads.customers(A, {});
    const byId = Object.fromEntries(list.items.map((c: any) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual([String(buyer._id), String(guest._id), String(erased._id)].sort());
    expect(byId[String(buyer._id)]).toMatchObject({ name: 'Sara', email: 'sara@example.com', tags: ['vip'], email_marketing: true, guest: false });
    expect(byId[String(guest._id)]).toMatchObject({ email: 'real@example.com', guest: true, email_marketing: false });
    expect(byId[String(erased._id)]).toMatchObject({ name: null, email: null, phone: null, tags: [], erased: true });
    await expect(reads.customer(A, String(stranger._id))).rejects.toThrow('Customer not found');
    await expect(reads.customer(B, String(stranger._id))).resolves.toMatchObject({ email: 'x@example.com' });
  });

  it('fulfil: own order only, validated, through the dashboard\'s fulfil path, once per Idempotency-Key', async () => {
    const line = item();
    const o = await M.orderModel.create({ orderNumber: 'F-1', currency: 'PKR', isDelete: false, sellerOrders: [{ storeId: A, sellerId: SELLER, status: 'processing', items: [line] }] });
    const theirs = await M.orderModel.create({ orderNumber: 'F-2', currency: 'PKR', isDelete: false, sellerOrders: [{ storeId: B, items: [line] }] });
    const body = { line_items: [{ id: String(line._id), quantity: 2 }], carrier: 'TCS', tracking_number: 'T123', tracking_url: 'https://tcs.example/T123' };
    await expect(writes.fulfilOrder(caller, String(theirs._id), body)).rejects.toThrow('Order not found');
    await expect(writes.fulfilOrder(caller, String(o._id), { line_items: [] })).rejects.toThrow('line_items must list');
    await expect(writes.fulfilOrder(caller, String(o._id), { line_items: [{ id: 'x', quantity: 1 }] })).rejects.toThrow('line item needs the id');
    await expect(writes.fulfilOrder(caller, String(o._id), { ...body, tracking_url: 'javascript:alert(1)' })).rejects.toThrow('tracking_url');
    expect(fulfilItems).not.toHaveBeenCalled();
    const run = () => writes.once(caller, 'fulfil-key-1', { id: String(o._id), body }, () => writes.fulfilOrder(caller, String(o._id), body));
    expect((await run()).replayed).toBe(false);
    expect((await run()).replayed).toBe(true);
    expect(fulfilItems).toHaveBeenCalledTimes(1);
    expect(fulfilItems).toHaveBeenCalledWith(SELLER, A, String(o._id), { items: [{ itemId: String(line._id), quantity: 2 }], carrier: 'TCS', trackingNumber: 'T123', trackingUrl: 'https://tcs.example/T123', notifyCustomer: true }, undefined, 'Solvexo API');
  });
});

d('webhooks a token makes for itself (REST hooks for Zapier / Make)', () => {
  jest.setTimeout(60000);
  let conn: Connection; let hooks: any; let tokens: any; let subs: any;
  const S = new Types.ObjectId().toHexString();
  const zap = { id: 'tok-zap', storeId: S, scopes: ['read_orders', 'write_inventory'], appInstallId: 'inst-1' };
  const other = { id: 'tok-other', storeId: S, scopes: ['read_orders'] };

  beforeAll(async () => {
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'a'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `mapiv1_hooks_${Date.now()}` }).asPromise();
    const { WebhookSubscriptionSchema, WebhookDeliverySchema, ApiTokenSchema } = await import('./merchant-api.schema');
    const { MerchantWebhooksService } = await import('./merchant-webhooks.service');
    const { ApiTokensService } = await import('./api-tokens.service');
    subs = conn.model('WebhookSubscription', WebhookSubscriptionSchema);
    const act: any = { log: jest.fn(async () => undefined) };
    hooks = new MerchantWebhooksService(subs, conn.model('WebhookDelivery', WebhookDeliverySchema) as any, { repositories: {} } as any, act);
    tokens = new ApiTokensService(conn.model('ApiToken', ApiTokenSchema) as any, act, hooks);
  });
  afterAll(async () => { await conn?.dropDatabase(); await conn?.close(); });

  it('subscribing needs the read permission of every event; the secret comes back once; it belongs to the token and its install', async () => {
    await expect(hooks.createForToken(zap, { url: 'https://hooks.zapier.com/x', events: ['order.paid', 'customer.created'] })).rejects.toThrow(/customer.created: it needs read_customers/);
    await expect(hooks.createForToken(zap, { url: 'http://insecure.example.com', events: ['order.paid'] })).rejects.toThrow(/https/);
    await expect(hooks.createForToken(zap, { url: 'https://hooks.zapier.com/x', events: ['nope'] })).rejects.toThrow(/events must list/);
    const r = await hooks.createForToken(zap, { url: 'https://hooks.zapier.com/hooks/standard/1', events: ['order.paid', 'inventory.changed'] });
    expect(r).toMatchObject({ url: 'https://hooks.zapier.com/hooks/standard/1', events: ['order.paid', 'inventory.changed'], enabled: true });
    expect(r.secret).toMatch(/^whsec_/);
    const row = await subs.findById(r.id).lean();
    expect(row).toMatchObject({ apiTokenId: 'tok-zap', appInstallId: 'inst-1', description: 'Made through the API' });
    expect((await hooks.listForToken(zap)).items.map((h: any) => h.id)).toEqual([r.id]);
    expect(JSON.stringify(await hooks.listForToken(zap))).not.toMatch(/whsec_|secretEnc/);
  });

  it('another token can\'t see or delete it; the store owner\'s own webhook limit doesn\'t count it', async () => {
    const mine = (await hooks.listForToken(zap)).items[0];
    expect((await hooks.listForToken(other)).items).toEqual([]);
    await expect(hooks.removeForToken(other, mine.id)).rejects.toThrow(/not found/);
    await expect(hooks.removeForToken({ ...zap, storeId: new Types.ObjectId().toHexString() }, mine.id)).rejects.toThrow(/not found/);
    expect(await subs.countDocuments({ storeId: S, appInstallId: null, apiTokenId: null })).toBe(0);
    expect(await hooks.removeForToken(zap, mine.id)).toEqual({ success: true });
    expect(await subs.countDocuments({ apiTokenId: 'tok-zap' })).toBe(0);
  });

  it('revoking the token removes the webhooks it made', async () => {
    const t = await tokens.create(S, { id: 'u1', role: 'seller' }, { name: 'Zapier', scopes: ['read_orders'] });
    await hooks.createForToken({ id: t.id, storeId: S, scopes: ['read_orders'] }, { url: 'https://hooks.zapier.com/2', events: ['order.created'] });
    expect(await subs.countDocuments({ apiTokenId: t.id })).toBe(1);
    await tokens.revoke(S, { id: 'u1', role: 'seller' }, t.id);
    expect(await subs.countDocuments({ apiTokenId: t.id })).toBe(0);
  });
});
