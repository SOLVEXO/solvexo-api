/* eslint-disable prettier/prettier */
/**
 * Product subscriptions on a real MongoDB, direct calls (no Redis): plan validation, tenant isolation, subscribe,
 * renewal (idempotent per cycle, long outage, max cycles), stock/failure handling, dunning, buyer controls, report.
 * Draft-order creation/completion is replaced by a fake that makes a simple order (its stock logic has its own specs).
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit selling-plans.integration
 */
import mongoose, { Connection } from 'mongoose';
import { SellingPlanGroupSchema, SubscriptionContractSchema, SubscriptionCycleSchema } from './selling-plan.schema';
import { SellingPlansService } from './selling-plans.service';
import { addInterval, discountedPrice, validateGroup } from './selling-plan.util';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const A = 'storeA'; const B = 'storeB';
const seller = { id: 'sel1', role: 'seller' };
const P1 = new mongoose.Types.ObjectId().toHexString();
const DAY = 86_400_000;

describe('selling plan util (pure)', () => {
  it('month math clamps month ends; weeks add 7 days', () => {
    expect(addInterval(new Date('2026-01-31T00:00:00Z'), 'month', 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addInterval(new Date('2026-01-15T00:00:00Z'), 'month', 3).toISOString().slice(0, 10)).toBe('2026-04-15');
    expect(addInterval(new Date('2026-01-01T00:00:00Z'), 'week', 2).toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(discountedPrice(100, 15)).toBe(85);
    expect(discountedPrice(100, 500)).toBe(10);
  });
  it('group validation refuses bad frequencies, discounts and duplicates', () => {
    const ok = { name: 'Coffee', options: [{ unit: 'month', count: 1, discountPercent: 10 }] };
    expect(validateGroup(ok, false).ok).toBe(true);
    expect(validateGroup({ ...ok, options: [] }, false).ok).toBe(false);
    expect(validateGroup({ ...ok, options: [{ unit: 'day', count: 1 }] }, false).ok).toBe(false);
    expect(validateGroup({ ...ok, options: [{ unit: 'month', count: 1, discountPercent: 95 }] }, false).ok).toBe(false);
    expect(validateGroup({ ...ok, options: [{ unit: 'month', count: 1 }, { unit: 'month', count: 1 }] }, false).ok).toBe(false);
    expect(validateGroup({ ...ok, productIds: ['nope'] }, false).ok).toBe(false);
    expect(validateGroup({ ...ok, trialDays: 200 }, false).ok).toBe(false);
    expect(validateGroup({ ...ok, taxPercent: -1 }, false).ok).toBe(false);
    expect(validateGroup({ trialDays: 5 }, true)).toMatchObject({ ok: true, data: { trialDays: 5 } });
  });
});

d('product subscriptions (real Mongo, direct calls)', () => {
  let conn: Connection; let m: any; let svc: SellingPlansService; let mails: any[]; let drafts: any;
  const addr = { recipientName: 'Ali', addressLine1: '1 Road', city: 'Karachi', phoneNumber: '0300' };

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `sub_it_${Date.now()}` }).asPromise();
    const loose = (n: string, s = false) => conn.model(n, new mongoose.Schema(s ? { _id: String } : {}, { strict: false }));
    m = {
      groups: conn.model('SellingPlanGroup', SellingPlanGroupSchema), contracts: conn.model('SubscriptionContract', SubscriptionContractSchema), cycles: conn.model('SubscriptionCycle', SubscriptionCycleSchema),
      stores: loose('Store', true), users: loose('User'), products: loose('Product'), variants: loose('ProductVariant'), orders: loose('Order'),
    };
    await Promise.all([m.groups.init(), m.contracts.init(), m.cycles.init()]);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  let productId: string; let variantId: string; let userId: string; let groupId: string; let optionId: string;
  const mkGroup = async (extra: any = {}) => {
    const g: any = await svc.createGroup(A, seller, { name: `Plan ${Math.random().toString(36).slice(2, 7)}`, options: [{ unit: 'month', count: 1, discountPercent: 10 }], productIds: [productId], shippingAmount: 5, taxPercent: 10, ...extra });
    groupId = String(g._id); optionId = g.options[0].id; return g;
  };
  const subscribe = (extra: any = {}) => svc.subscribe(A, userId, { groupId, optionId, variantId, quantity: 2, address: addr, ...extra });

  beforeEach(async () => {
    for (const x of Object.values(m) as any[]) await x.deleteMany({});
    await m.stores.create([{ _id: A, sellerId: 'sel1', name: 'Shop A', baseCurrency: 'USD', isDelete: false }, { _id: B, sellerId: 'sel2', name: 'Shop B', isDelete: false }]);
    productId = String((await m.products.create({ storeId: A, status: 'active', isDelete: false })).id);
    variantId = String((await m.variants.create({ storeId: A, productId, price: 100, stock: 50, isDelete: false })).id);
    userId = String((await m.users.create({ storeId: A, name: 'Ali', email: 'ali@x.com', isDelete: false })).id);
    mails = [];
    let n = 0;
    drafts = {
      failWith: null as string | null,
      create: async (_s: string, _sel: string, dto: any) => ({ _id: new mongoose.Types.ObjectId(), ...dto, total: dto.items.reduce((s: number, i: any) => s + i.unitPrice * i.quantity, 0) + dto.shippingAmount + dto.taxAmount, currency: 'USD' }),
      complete: async (storeId: string, _sel: string, id: string) => {
        if (drafts.failWith) throw new Error(drafts.failWith);
        const o: any = await m.orders.create({ isPaid: false, orderNumber: `SUB-${++n}`, storeId, isDelete: false, createdAt: new Date() });
        return { draftOrderId: id, orderId: String(o._id), orderNumber: o.orderNumber };
      },
      deleteDraft: async () => ({ success: true }),
    };
    const db: any = { repositories: { storeModel: m.stores, userModel: m.users, productModel: m.products, productVariantModel: m.variants, orderModel: m.orders } };
    svc = new SellingPlansService(m.groups, m.contracts, m.cycles, db, { log: jest.fn().mockResolvedValue(undefined) } as any, { get: () => drafts } as any, undefined, { sendCustomerEmail: async (a: any) => { mails.push(a); return 'sent'; } } as any);
    await mkGroup();
  });

  it('plans are per store: another store sees none, cannot change or list them, and cannot assign foreign products', async () => {
    expect(await svc.listGroups(B)).toHaveLength(0);
    await expect(svc.updateGroup(B, seller, groupId, { name: 'Hijack' })).rejects.toThrow(/not found/i);
    const foreign = String((await m.products.create({ storeId: B, status: 'active', isDelete: false })).id);
    await expect(svc.createGroup(A, seller, { name: 'X', options: [{ unit: 'week', count: 1 }], productIds: [foreign] })).rejects.toThrow(/do not belong/);
    await expect(svc.createGroup(A, seller, { name: (await svc.listGroups(A) as any)[0].name, options: [{ unit: 'week', count: 1 }] })).rejects.toThrow(/already exists/);
  });

  it('public plans list shows the discounted price of the chosen variant and respects variant limits', async () => {
    const plans = await svc.plansFor(A, productId, variantId);
    expect(plans[0].options[0].unitPrice).toBe(90);
    await svc.updateGroup(A, seller, groupId, { variantIds: [new mongoose.Types.ObjectId().toHexString()] });
    expect(await svc.plansFor(A, productId, variantId)).toHaveLength(0);
    expect(await svc.plansFor(B, productId, variantId)).toHaveLength(0);
  });

  it('subscribe refuses guests, bad quantity, missing address, foreign/ineligible products and other stores\' plans', async () => {
    const guest = String((await m.users.create({ storeId: A, isGuest: true, isDelete: false })).id);
    await expect(svc.subscribe(A, guest, { groupId, optionId, variantId, quantity: 1, address: addr })).rejects.toThrow(/Sign in/);
    await expect(subscribe({ quantity: 0 })).rejects.toThrow(/Quantity/);
    await expect(subscribe({ quantity: 1.5 })).rejects.toThrow(/Quantity/);
    await expect(subscribe({ address: { recipientName: 'x' } })).rejects.toThrow(/address/);
    await expect(subscribe({ optionId: 'nope' })).rejects.toThrow(/frequency/);
    const other = String((await m.variants.create({ storeId: A, productId: String((await m.products.create({ storeId: A, status: 'active', isDelete: false })).id), price: 5, isDelete: false })).id);
    await expect(subscribe({ variantId: other })).rejects.toThrow(/not part of that plan/);
    await expect(svc.subscribe(B, userId, { groupId, optionId, variantId, quantity: 1, address: addr })).rejects.toThrow();
  });

  it('subscribing without a trial places the first order at once: discounted price, plan shipping, plan tax, next date one month on', async () => {
    const created: any[] = [];
    const orig = drafts.create; drafts.create = async (...a: any[]) => { const r = await orig(...a); created.push(a[2]); return r; };
    const r = await subscribe();
    expect(r.firstOrder).toMatchObject({ ok: true });
    expect(created[0].items[0]).toMatchObject({ unitPrice: 90, quantity: 2 });
    expect(created[0].shippingAmount).toBe(5); expect(created[0].taxAmount).toBe(18);
    const c: any = await m.contracts.findById(r.contractId);
    expect(c.cyclesDone).toBe(1); expect(c.lastOrderId).toBeTruthy();
    const days = (c.nextBillingAt.getTime() - Date.now()) / DAY; expect(days).toBeGreaterThan(27); expect(days).toBeLessThan(32);
    expect(mails.map((x) => x.event)).toEqual(['subscription_renewal_placed']);
  });

  it('with a trial the first order waits; nothing is ordered until it is due', async () => {
    await svc.updateGroup(A, seller, groupId, { trialDays: 7 });
    const r = await subscribe();
    expect(r.firstOrder).toBeNull();
    expect(await m.orders.countDocuments({})).toBe(0);
    expect((await svc.runDue(new Date())).ordered).toBe(0);
    expect((await svc.runDue(new Date(Date.now() + 8 * DAY))).ordered).toBe(1);
  });

  it('a duplicate renewal is impossible: parallel workers and re-runs create ONE order per cycle', async () => {
    await svc.updateGroup(A, seller, groupId, { trialDays: 1 });
    const { contractId } = await subscribe();
    const later = new Date(Date.now() + 2 * DAY);
    const res = await Promise.all([svc.renew(contractId, later), svc.renew(contractId, later), svc.renew(contractId, later)]);
    expect(res.filter((x) => x.ok)).toHaveLength(1);
    await svc.renew(contractId, later);
    expect(await m.orders.countDocuments({})).toBe(1);
    expect(await m.cycles.countDocuments({ contractId })).toBe(1);
  });

  it('after a long outage one order is placed and the next date is in the future (no catch-up burst)', async () => {
    const { contractId } = await subscribe();
    await m.contracts.updateOne({ _id: contractId }, { $set: { nextBillingAt: new Date(Date.now() - 100 * DAY) } });
    await svc.renew(contractId);
    const c: any = await m.contracts.findById(contractId);
    expect(c.nextBillingAt.getTime()).toBeGreaterThan(Date.now());
    expect(await m.orders.countDocuments({})).toBe(2);
  });

  it('cancel during the cycle stops renewals; a paused or cancelled contract is never billed', async () => {
    const { contractId } = await subscribe();
    await svc.buyerAction(A, userId, contractId, 'cancel', {});
    await expect(svc.buyerAction(A, userId, contractId, 'cancel', {})).rejects.toThrow(/cannot be/);
    const far = new Date(Date.now() + 90 * DAY);
    expect((await svc.renew(contractId, far)).ok).toBe(false);
    const { contractId: c2 } = await subscribe();
    await svc.buyerAction(A, userId, c2, 'pause', {});
    expect((await svc.runDue(far)).ordered).toBe(0);
    expect(await m.orders.countDocuments({})).toBe(2);
  });

  it('maxCycles completes the contract after the last order', async () => {
    await svc.updateGroup(A, seller, groupId, { maxCycles: 2 });
    const { contractId } = await subscribe();
    await svc.renew(contractId, new Date(Date.now() + 40 * DAY));
    const c: any = await m.contracts.findById(contractId);
    expect(c.status).toBe('completed'); expect(c.cyclesDone).toBe(2);
    expect((await svc.renew(contractId, new Date(Date.now() + 80 * DAY))).ok).toBe(false);
  });

  it('when the order cannot be placed (stock) no order is made, it retries tomorrow and pauses on the third failure with an email', async () => {
    const { contractId } = await subscribe();
    drafts.failWith = 'Not enough stock for this item';
    let t = Date.now() + 40 * DAY;
    const r1 = await svc.renew(contractId, new Date(t));
    expect(r1.ok).toBe(false);
    let c: any = await m.contracts.findById(contractId);
    expect(c.stockFailures).toBe(1); expect(c.status).toBe('active'); expect(await m.cycles.countDocuments({ contractId, cycleNo: 2 })).toBe(0);
    expect(c.nextBillingAt.getTime()).toBeGreaterThan(t);
    t = c.nextBillingAt.getTime() + 1000; await svc.renew(contractId, new Date(t));
    c = await m.contracts.findById(contractId); t = c.nextBillingAt.getTime() + 1000; await svc.renew(contractId, new Date(t));
    c = await m.contracts.findById(contractId);
    expect(c.status).toBe('paused'); expect(c.pausedReason).toMatch(/Not enough stock/);
    expect(mails.map((x) => x.event)).toContain('subscription_paused');
    drafts.failWith = null;
    await svc.buyerAction(A, userId, contractId, 'resume', {});
    const back = await svc.renew(contractId, new Date(t + 3 * DAY));
    expect(back.ok).toBe(true);
  });

  it('dunning: reminder at 3 and 5 days, pause at 7, once each; a paid order is left alone', async () => {
    const { contractId } = await subscribe();
    const c0: any = await m.contracts.findById(contractId);
    const order: any = await m.orders.findById(c0.lastOrderId);
    const at = (days: number) => new Date(order.createdAt.getTime() + days * DAY);
    expect((await svc.runDunning(at(1))).sent).toBe(0);
    expect((await svc.runDunning(at(3.1))).sent).toBe(1);
    expect((await svc.runDunning(at(3.2))).sent).toBe(0);
    expect((await svc.runDunning(at(5.1))).sent).toBe(1);
    expect((await svc.runDunning(at(7.1))).sent).toBe(1);
    const c: any = await m.contracts.findById(contractId);
    expect(c.status).toBe('paused'); expect(c.dunningStage).toBe(3);
    expect(mails.map((x) => x.event)).toEqual(['subscription_renewal_placed', 'subscription_payment_reminder', 'subscription_payment_reminder', 'subscription_paused']);
    const { contractId: paid } = await subscribe();
    const pc: any = await m.contracts.findById(paid);
    await m.orders.updateOne({ _id: pc.lastOrderId }, { $set: { isPaid: true } });
    expect((await svc.runDunning(at(10))).sent).toBe(0);
    expect(((await m.contracts.findById(paid)) as any).status).toBe('active');
  });

  it('buyer controls: skip moves the next date once, pause/resume, frequency, address; other customers and stores are refused', async () => {
    const { contractId } = await subscribe();
    const before: any = await m.contracts.findById(contractId);
    const sk: any = await svc.buyerAction(A, userId, contractId, 'skip', {});
    expect(sk.nextBillingAt.getTime()).toBeGreaterThan(before.nextBillingAt.getTime());
    await svc.buyerAction(A, userId, contractId, 'pause', {});
    await expect(svc.buyerAction(A, userId, contractId, 'skip', {})).rejects.toThrow(/cannot be/);
    await svc.buyerAction(A, userId, contractId, 'resume', {});
    const g: any = await svc.updateGroup(A, seller, groupId, { options: [{ unit: 'month', count: 1, discountPercent: 10 }, { unit: 'week', count: 2, discountPercent: 5 }] });
    const wk = g.options.find((o: any) => o.unit === 'week').id;
    const f: any = await svc.buyerAction(A, userId, contractId, 'frequency', { optionId: wk });
    expect(f.terms).toMatchObject({ unit: 'week', count: 2, discountPercent: 5 });
    const ad: any = await svc.buyerAction(A, userId, contractId, 'address', { address: { ...addr, city: 'Lahore' } });
    expect(ad.shippingAddress.city).toBe('Lahore');
    await expect(svc.buyerAction(A, userId, contractId, 'address', { address: { recipientName: 'x' } })).rejects.toThrow(/address/);
    const stranger = String((await m.users.create({ storeId: A, email: 'z@x.com', isDelete: false })).id);
    await expect(svc.buyerAction(A, stranger, contractId, 'cancel', {})).rejects.toThrow(/not found/i);
    await expect(svc.buyerAction(B, userId, contractId, 'cancel', {})).rejects.toThrow(/not found/i);
    expect(await svc.mine(A, stranger)).toHaveLength(0);
    await expect(svc.sellerAction(B, seller, contractId, 'cancel')).rejects.toThrow(/not found/i);
    await expect(svc.buyerAction(A, userId, contractId, 'explode', {})).rejects.toThrow(/Unknown action/);
  });

  it('seller can pause/cancel; upcoming and the report only count this store', async () => {
    const { contractId } = await subscribe();
    const rep: any = await svc.report(A);
    expect(rep).toMatchObject({ currency: 'USD', active: 1, paused: 0 });
    expect(rep.monthlyRecurring).toBeCloseTo(90 * 2 + 5, 1);
    expect((await svc.report(B) as any).active).toBe(0);
    expect(await svc.upcoming(A, 60)).toHaveLength(1);
    expect(await svc.upcoming(B, 60)).toHaveLength(0);
    await svc.sellerAction(A, seller, contractId, 'pause');
    expect(((await svc.report(A)) as any).paused).toBe(1);
    expect((await svc.listContracts(A, { status: 'paused' })).total).toBe(1);
    expect((await svc.listContracts(B, {})).total).toBe(0);
  });
});
