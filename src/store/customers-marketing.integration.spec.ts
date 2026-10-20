/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for the Customers list's email-marketing status, subscriber-only rows, filters, export and
 * the consent rules (single toggle, bulk, create). Skipped unless CUSTOMERS_IT_MONGO is set (a plain standalone
 * mongod is enough), e.g.
 *   CUSTOMERS_IT_MONGO="mongodb://127.0.0.1:27098" npx jest customers-marketing.integration
 * Creates a throw-away database and drops it afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection } from 'mongoose';
import { StoreService } from './store.service';
import { StoreSchema } from './schemas/store.schema';
import { StoreCustomerMetaSchema } from './schemas/store-customer-meta.schema';
import { UserSchema } from '../users/schemas/user.schema';
import { OrderSchema } from '../orders/schemas/order.schema';
import { NewsletterSubscriberSchema } from '../newsletter/schemas/newsletter-subscriber.schema';

const URI = process.env.CUSTOMERS_IT_MONGO;
const d = URI ? describe : describe.skip;

d('Customers + email marketing on a real MongoDB', () => {
  let conn: Connection;
  let r: any;
  let svc: StoreService;
  let storeId: string;
  const SELLER = 'SELLER';
  const ids: Record<string, string> = {};

  const sub = (email: string, extra: any = {}) => r.newsletterSubscriberModel.create({
    storeId, email, unsubscribeToken: 't-' + email, source: 'checkout', consentAt: new Date(), isActive: true, ...extra,
  });
  const user = async (key: string, doc: any) => {
    const res = await r.userModel.collection.insertOne({ storeId, role: 'user', isDelete: false, createdAt: new Date(), ...doc });
    ids[key] = String(res.insertedId);
  };
  let orderSeq = 0;
  const order = (key: string) => r.orderModel.collection.insertOne({
    orderNumber: `ORD-${++orderSeq}`, userId: ids[key], isDelete: false, createdAt: new Date(), sellerOrders: [{ storeId, subtotal: 100 }],
  });
  const list = async (query: any = {}) => (await svc.getStoreCustomers(SELLER, storeId, { limit: 50, ...query })).data as any;

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `customers_it_${Date.now()}` }).asPromise();
    r = {
      storeModel: conn.model('Store', StoreSchema),
      orderModel: conn.model('Order', OrderSchema),
      userModel: conn.model('User', UserSchema),
      storeCustomerMetaModel: conn.model('StoreCustomerMeta', StoreCustomerMetaSchema),
      newsletterSubscriberModel: conn.model('NewsletterSubscriber', NewsletterSubscriberSchema),
    };
    const store = await r.storeModel.collection.insertOne({ name: 'S', sellerId: SELLER, isDelete: false });
    storeId = String(store.insertedId);

    await user('ann', { name: 'Ann', email: 'ann@x.com' });
    await user('bob', { name: 'Bob', email: 'bob@x.com' });
    await user('cat', { name: 'Cat', email: 'cat@x.com' });
    await user('dan', { name: 'Dan', email: 'dan@x.com' });
    await user('eve', { name: 'Eve', email: 'eve@x.com' });
    await user('guest', { name: 'Guest', email: 'guest-1@guest.local', contactEmail: 'gina@x.com', isGuest: true });
    for (const k of ['ann', 'bob', 'cat', 'guest']) await order(k);
    await r.storeCustomerMetaModel.create({ storeId, userId: ids.dan });

    await sub('ann@x.com');
    await sub('cat@x.com', { isActive: false, unsubscribedAt: new Date() });
    await sub('dan@x.com', { isActive: false, pendingConfirmation: true, consentAt: null });
    await sub('eve@x.com', { source: 'store_footer' });
    await sub('zed@x.com', { source: 'store_footer' });
    await sub('gina@x.com');
    await r.newsletterSubscriberModel.create({ storeId: 'OTHER', email: 'leak@x.com', unsubscribeToken: 'x', isActive: true });

    svc = Object.assign(Object.create(StoreService.prototype), {
      databaseService: { repositories: r },
      activityLogService: { log: jest.fn() },
    });
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  it('computes the four marketing states and lists subscriber-only signups once', async () => {
    const data = await list();
    const by = Object.fromEntries(data.customers.map((c: any) => [c.email, c]));
    expect(by['ann@x.com'].marketingStatus).toBe('subscribed');
    expect(by['bob@x.com'].marketingStatus).toBe('not_subscribed');
    expect(by['cat@x.com'].marketingStatus).toBe('unsubscribed');
    expect(by['dan@x.com'].marketingStatus).toBe('pending');
    expect(by['eve@x.com']).toMatchObject({ isSubscriberOnly: true, name: 'Eve', marketingStatus: 'subscribed' });
    expect(String(by['zed@x.com']._id)).toMatch(/^sub:/);
    // a guest is matched through contactEmail and is not repeated as a subscriber-only row
    expect(data.customers.some((c: any) => c.email === 'gina@x.com')).toBe(false);
    expect(data.customers.find((c: any) => c.email === 'guest-1@guest.local').marketingStatus).toBe('subscribed');
    expect(by['leak@x.com']).toBeUndefined();
    expect(new Set(data.customers.map((c: any) => String(c._id))).size).toBe(data.customers.length);
    expect(data.pagination.total).toBe(7);
    expect(data.summary).toMatchObject({ subscribed: 4, totalOrders: 4, totalRevenue: 400 });
  });

  it('filters by marketing status and ignores unknown values', async () => {
    expect((await list({ marketing: 'subscribed' })).pagination.total).toBe(4);
    expect((await list({ marketing: 'unsubscribed' })).customers.map((c: any) => c.email)).toEqual(['cat@x.com']);
    expect((await list({ marketing: 'pending' })).customers.map((c: any) => c.email)).toEqual(['dan@x.com']);
    expect((await list({ marketing: 'not_subscribed' })).customers.map((c: any) => c.email)).toEqual(['bob@x.com']);
    expect((await list({ marketing: '$ne' })).pagination.total).toBe(7);
  });

  it('paginates without repeating or losing rows', async () => {
    const pages = [await list({ limit: 3, page: 1 }), await list({ limit: 3, page: 2 }), await list({ limit: 3, page: 3 })];
    const all = pages.flatMap((p) => p.customers.map((c: any) => String(c._id)));
    expect(all).toHaveLength(7);
    expect(new Set(all).size).toBe(7);
  });

  it('keeps the admin customer list free of subscriber-only rows', async () => {
    const res: any = await svc.getStoreCustomersAdmin(storeId, { limit: 50 });
    expect(res.data.customers.some((c: any) => String(c._id).startsWith('sub:'))).toBe(false);
  });

  it('exports the Email Marketing column', async () => {
    const csv = await svc.exportStoreCustomers(SELLER, storeId, {});
    expect(csv.split('\n')[0]).toContain('Email Marketing');
    expect(csv).toContain('Unsubscribed');
    expect(csv).toContain('Not subscribed');
  });

  it('single toggle: never re-subscribes an opt-out or an unconfirmed sign-up', async () => {
    await expect(svc.updateStoreCustomerMeta(SELLER, storeId, ids.cat, { marketingOptIn: true })).rejects.toThrow(/unsubscribed/i);
    await expect(svc.updateStoreCustomerMeta(SELLER, storeId, ids.dan, { marketingOptIn: true })).rejects.toThrow(/confirm/i);
    const on: any = await svc.updateStoreCustomerMeta(SELLER, storeId, ids.bob, { marketingOptIn: true });
    expect(on.data.marketingStatus).toBe('subscribed');
    expect(await r.newsletterSubscriberModel.findOne({ storeId, email: 'bob@x.com' }).lean()).toMatchObject({ isActive: true, source: 'seller' });
    const off: any = await svc.updateStoreCustomerMeta(SELLER, storeId, ids.bob, { marketingOptIn: false });
    expect(off.data.marketingStatus).toBe('unsubscribed');
  });

  it('bulk: subscribes new people, skips opt-outs, unsubscribes and cancels pending, handles subscriber-only ids', async () => {
    const zed: any = await r.newsletterSubscriberModel.findOne({ storeId, email: 'zed@x.com' }).lean();

    // bob is now unsubscribed (previous test), cat opted out, dan pending: all three are skipped, never re-subscribed
    const sk: any = await svc.bulkSetCustomerMarketing(SELLER, storeId, { customerIds: [ids.bob, ids.cat, ids.dan], subscribed: true });
    expect(sk.data).toEqual({ updated: 0, skipped: 3 });

    const un: any = await svc.bulkSetCustomerMarketing(SELLER, storeId, { customerIds: [ids.ann, ids.dan, 'sub:' + zed._id, ids.cat], subscribed: false });
    expect(un.data.updated).toBe(3); // ann, dan (pending cancelled), zed; cat was already off
    expect(await r.newsletterSubscriberModel.findOne({ storeId, email: 'dan@x.com' }).lean()).toMatchObject({ isActive: false, pendingConfirmation: false });
    expect(await r.newsletterSubscriberModel.findOne({ storeId, email: 'zed@x.com' }).lean()).toMatchObject({ isActive: false });
    // the subscriber row is the source of truth (the meta flag is only a mirror, never created just for this)
    const after = (await list()).customers.find((c: any) => c.email === 'ann@x.com');
    expect(after.marketingStatus).toBe('unsubscribed');

    await expect(svc.bulkSetCustomerMarketing('SOMEONE_ELSE', storeId, { customerIds: [ids.ann], subscribed: false })).rejects.toThrow();
    await expect(svc.bulkSetCustomerMarketing(SELLER, storeId, { customerIds: ['nope'], subscribed: true })).rejects.toThrow();
  });

  it('create customer: email-only works, consent never overrides an opt-out, bad email rejected', async () => {
    const a: any = await svc.createStoreCustomer(SELLER, storeId, { email: 'New@X.com', marketingConsent: true });
    expect(a.data).toMatchObject({ name: 'new@x.com', marketingSubscribed: true });
    const b: any = await svc.createStoreCustomer(SELLER, storeId, { name: 'Cat2', email: 'cat@x.com', marketingConsent: true });
    expect(b.data.marketingSubscribed).toBe(false);
    expect(await r.newsletterSubscriberModel.findOne({ storeId, email: 'cat@x.com' }).lean()).toMatchObject({ isActive: false });
    await expect(svc.createStoreCustomer(SELLER, storeId, { email: 'not-an-email' })).rejects.toThrow();
  });
});
