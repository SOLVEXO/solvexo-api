/* eslint-disable prettier/prettier */
/**
 * Checkout rules: pure evaluation + validation, then the service on a real MongoDB (direct calls).
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit checkout-rules.integration
 */
import mongoose, { Connection } from 'mongoose';
import { CheckoutRuleSchema } from './checkout-rules.schema';
import { CheckoutRulesService, buildContext } from './checkout-rules.service';
import { applyShippingRules, evaluateRules, filterPaymentMethods, validateRule, type RuleLike } from './checkout-rules.util';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const OID = (n: number) => String(n).padStart(24, 'a');

const ctx = (over: any = {}) => buildContext({ lines: [{ productId: OID(1), quantity: 2, total: 200 }, { productId: OID(2), quantity: 1, total: 50 }], ...over });
const rule = (type: any, action: any, conditions: any[] = [], extra: any = {}): RuleLike => ({ _id: extra._id ?? Math.random().toString(36).slice(2), name: extra.name ?? 'r', type, status: 'active', priority: extra.priority ?? 100, conditions, action });
const disc = (v: any, extra: any = {}) => ({ kind: 'percent', value: 10, appliesTo: 'order', productIds: [], exclusive: true, label: 'Deal', ...v, ...extra });

describe('rule validation (pure)', () => {
  const base = { name: 'x', type: 'validation', action: { message: 'No' } };
  it('refuses unknown fields/operators/actions and operator-looking values', () => {
    expect(validateRule({ ...base, conditions: [{ field: 'hack', op: 'eq', value: 1 }] }, false).ok).toBe(false);
    expect(validateRule({ ...base, conditions: [{ field: 'subtotal', op: '$where', value: 1 }] }, false).ok).toBe(false);
    expect(validateRule({ ...base, conditions: [{ field: 'subtotal', op: 'gt', value: { $gt: 1 } }] }, false).ok).toBe(false);
    expect(validateRule({ ...base, conditions: [{ field: 'country', op: 'eq', value: { $ne: 'x' } }] }, false).ok).toBe(false);
    expect(validateRule({ ...base, conditions: [{ field: 'isB2B', op: 'eq', value: 'yes' }] }, false).ok).toBe(false);
    expect(validateRule({ ...base, type: 'script', action: {} }, false).ok).toBe(false);
    expect(validateRule({ ...base, conditions: [{ field: 'itemCount', op: 'gt', value: 'abc' }] }, false).ok).toBe(false);
  });
  it('caps conditions and list sizes; discount rules cannot use address fields', () => {
    const nine = Array.from({ length: 9 }, () => ({ field: 'subtotal', op: 'gt', value: 1 }));
    expect(validateRule({ ...base, conditions: nine }, false).ok).toBe(false);
    const many = { field: 'country', op: 'in', value: Array.from({ length: 21 }, (_, i) => `c${i}`) };
    expect(validateRule({ ...base, conditions: [many] }, false).ok).toBe(false);
    expect(validateRule({ name: 'd', type: 'discount', action: disc({}), conditions: [{ field: 'country', op: 'eq', value: 'pk' }] }, false).ok).toBe(false);
    expect(validateRule({ name: 'd', type: 'discount', action: disc({}), conditions: [{ field: 'subtotal', op: 'gte', value: 100 }] }, false).ok).toBe(true);
  });
  it('validates each action type and keeps the type fixed on update', () => {
    expect(validateRule({ name: 'a', type: 'discount', action: disc({ value: 0 }) }, false).ok).toBe(false);
    expect(validateRule({ name: 'a', type: 'discount', action: disc({ value: 101 }) }, false).ok).toBe(false);
    expect(validateRule({ name: 'a', type: 'discount', action: disc({ appliesTo: 'products', productIds: [] }) }, false).ok).toBe(false);
    expect(validateRule({ name: 'a', type: 'payment', action: { mode: 'hide', methods: [] } }, false).ok).toBe(false);
    expect(validateRule({ name: 'a', type: 'payment', action: { mode: 'hide', methods: ['Cash_On_Delivery'] } }, false)).toMatchObject({ ok: true, data: { action: { methods: ['cash_on_delivery'] } } });
    expect(validateRule({ name: 'a', type: 'shipping', action: { mode: 'rename', zoneIds: [OID(3)], newName: '' } }, false).ok).toBe(false);
    expect(validateRule({ name: 'a', type: 'shipping', action: { mode: 'hide' } }, false).ok).toBe(false);
    expect(validateRule({ name: 'a', type: 'validation', action: { message: '  ' } }, false).ok).toBe(false);
    expect(validateRule({ type: 'payment' }, true, 'discount').ok).toBe(false);
    expect(validateRule({ priority: 5000 }, true, 'discount').ok).toBe(false);
  });
});

describe('rule evaluation (pure)', () => {
  it('discount: percent on the order, fixed capped at the base, product-limited, never above the subtotal', () => {
    expect(evaluateRules([rule('discount', disc({ value: 10 }))], ctx()).discount.total).toBe(25);
    expect(evaluateRules([rule('discount', disc({ kind: 'fixed', value: 9999 }))], ctx()).discount.total).toBe(250);
    const only1 = evaluateRules([rule('discount', disc({ appliesTo: 'products', productIds: [OID(1)] }))], ctx());
    expect(only1.discount.total).toBe(20); expect(only1.discount.applied[0].productIds).toEqual([OID(1)]);
    expect(evaluateRules([rule('discount', disc({ appliesTo: 'products', productIds: [OID(9)] }))], ctx()).discount.total).toBe(0);
  });
  it('discount precedence: lowest priority number first; an exclusive rule ends the phase; non-exclusive rules stack', () => {
    const a = rule('discount', disc({ value: 10, label: 'A' }), [], { priority: 1 });
    const b = rule('discount', disc({ value: 50, label: 'B' }), [], { priority: 2 });
    expect(evaluateRules([b, a], ctx()).discount.applied.map((x) => x.label)).toEqual(['A']);
    const a2 = rule('discount', disc({ value: 10, label: 'A', exclusive: false }), [], { priority: 1 });
    const r = evaluateRules([b, a2], ctx()).discount;
    expect(r.applied.map((x) => x.label)).toEqual(['A', 'B']); expect(r.total).toBeLessThanOrEqual(250);
  });
  it('conditions: AND, volume breaks, and an unknown address never matches', () => {
    const vol = rule('discount', disc({ value: 15 }), [{ field: 'itemCount', op: 'gte', value: 3 }]);
    expect(evaluateRules([vol], ctx()).discount.total).toBe(37.5);
    expect(evaluateRules([vol], buildContext({ lines: [{ productId: OID(1), quantity: 1, total: 100 }] })).discount.total).toBe(0);
    const block = rule('validation', { message: 'Not here' }, [{ field: 'country', op: 'in', value: ['Pakistan', 'India'] }]);
    expect(evaluateRules([block], ctx()).blocks).toHaveLength(0);
    expect(evaluateRules([block], ctx({ address: { country: ' pakistan ' } })).blocks[0].message).toBe('Not here');
    const both = rule('validation', { message: 'x' }, [{ field: 'itemCount', op: 'gt', value: 1 }, { field: 'isGuest', op: 'eq', value: true }]);
    expect(evaluateRules([both], ctx()).blocks).toHaveLength(0);
    expect(evaluateRules([both], ctx({ isGuest: true })).blocks).toHaveLength(1);
  });
  it('validation: max quantity per line and customer tag / B2B conditions', () => {
    const max = rule('validation', { message: 'Max 2 per item' }, [{ field: 'maxLineQuantity', op: 'gt', value: 2 }]);
    expect(evaluateRules([max], ctx()).blocks).toHaveLength(0);
    expect(evaluateRules([max], buildContext({ lines: [{ productId: OID(1), quantity: 3, total: 30 }] })).blocks[0].message).toBe('Max 2 per item');
    const vip = rule('payment', { mode: 'hide', methods: ['cash_on_delivery'] }, [{ field: 'customerTags', op: 'contains', value: 'blocked' }]);
    expect(evaluateRules([vip], ctx({ customerTags: ['Blocked'] })).payment.hidden).toEqual(['cash_on_delivery']);
    expect(evaluateRules([vip], ctx()).payment.hidden).toEqual([]);
    const b2b = rule('payment', { mode: 'show_only', methods: ['b2b_terms', 'manual_bank_transfer'] }, [{ field: 'isB2B', op: 'eq', value: true }]);
    expect(filterPaymentMethods(['stripe', 'b2b_terms', 'cash_on_delivery'], evaluateRules([b2b], ctx({ isB2B: true }))).methods).toEqual(['b2b_terms']);
  });
  it('payment: hide beats show-only, two show-only rules intersect, nothing is ever "fail-open"', () => {
    const only = rule('payment', { mode: 'show_only', methods: ['stripe', 'cash_on_delivery'] });
    const hide = rule('payment', { mode: 'hide', methods: ['stripe'] });
    expect(filterPaymentMethods(['stripe', 'cash_on_delivery', 'manual_bank_transfer'], evaluateRules([only, hide], ctx())).methods).toEqual(['cash_on_delivery']);
    const only2 = rule('payment', { mode: 'show_only', methods: ['manual_bank_transfer'] });
    expect(filterPaymentMethods(['stripe', 'cash_on_delivery'], evaluateRules([only, only2], ctx())).methods).toEqual([]);
  });
  it('shipping: hide by id or type, rename, move to top in priority order; hiding everything is ignored', () => {
    const zones = [{ _id: OID(1), name: 'Standard', zoneType: 'shipping' }, { _id: OID(2), name: 'Express', zoneType: 'shipping' }, { _id: OID(3), name: 'Pickup', zoneType: 'pickup' }];
    const ev = evaluateRules([
      rule('shipping', { mode: 'hide', zoneIds: [], zoneType: 'pickup' }, [{ field: 'subtotal', op: 'lt', value: 1000 }]),
      rule('shipping', { mode: 'rename', zoneIds: [OID(2)], zoneType: null, newName: 'Next day' }),
      rule('shipping', { mode: 'reorder', zoneIds: [OID(2)], zoneType: null }, [], { priority: 2 }),
    ], ctx());
    const out = applyShippingRules(zones, ev);
    expect(out.zones.map((z) => z.name)).toEqual(['Next day', 'Standard']); expect(out.ignored).toBe(false);
    const all = evaluateRules([rule('shipping', { mode: 'hide', zoneIds: [OID(1), OID(2), OID(3)], zoneType: null })], ctx());
    const fo = applyShippingRules(zones, all);
    expect(fo.ignored).toBe(true); expect(fo.zones).toHaveLength(3);
  });
});

d('checkout rules service (real Mongo, direct calls)', () => {
  let conn: Connection; let m: any; let svc: CheckoutRulesService;
  const seller = { id: 'sel1', role: 'seller' };
  const A = 'storeA'; const B = 'storeB';
  const p1 = OID(1);
  const checkoutOf = (storeId: string, qty = 2, extra: any = {}) => ({ userId: 'u1', addressId: null, items: [{ storeId, productId: p1, quantity: qty, totalPrice: 100 * qty, type: 'physical' }], ...extra });

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `rules_it_${Date.now()}` }).asPromise();
    const loose = (n: string) => conn.model(n, new mongoose.Schema({}, { strict: false }));
    m = { rules: conn.model('CheckoutRule', CheckoutRuleSchema), products: loose('Product'), users: loose('User'), addresses: loose('Address'), carts: loose('Cart'), zones: loose('ShippingZone') };
    await m.rules.init();
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });
  beforeEach(async () => {
    for (const x of Object.values(m) as any[]) await x.deleteMany({});
    await m.products.create([{ _id: new mongoose.Types.ObjectId(p1), storeId: A, isDelete: false }]);
    const db: any = { repositories: { productModel: m.products, userModel: m.users, addressModel: m.addresses, cartModel: m.carts, shippingZoneModel: m.zones } };
    svc = new CheckoutRulesService(m.rules, db, { log: jest.fn().mockResolvedValue(undefined) } as any);
  });

  const mk = (b: any, storeId = A) => svc.create(storeId, seller, { status: 'active', ...b });

  it('rules are per store: list/update/delete from another store are refused; the type never changes; products must be this store\'s', async () => {
    const r: any = await mk({ name: 'Max', type: 'validation', conditions: [{ field: 'maxLineQuantity', op: 'gt', value: 5 }], action: { message: 'Max 5' } });
    expect((await svc.list(B))).toHaveLength(0);
    await expect(svc.update(B, seller, String(r._id), { name: 'Hijack' })).rejects.toThrow(/not found/i);
    await expect(svc.remove(B, seller, String(r._id))).rejects.toThrow(/not found/i);
    await expect(svc.update(A, seller, String(r._id), { type: 'payment' })).rejects.toThrow(/cannot change/);
    await expect(mk({ name: 'Foreign', type: 'discount', action: disc({ appliesTo: 'products', productIds: [OID(7)] }) })).rejects.toThrow(/do not belong/);
    await expect(svc.update(A, seller, String(r._id), { conditions: [{ field: 'productIds', op: 'contains', value: OID(8) }] })).rejects.toThrow(/do not belong/);
    await svc.remove(A, seller, String(r._id));
    expect(await svc.list(A)).toHaveLength(0);
  });

  it('a store holds at most 50 rules', async () => {
    await m.rules.insertMany(Array.from({ length: 50 }, (_, i) => ({ storeId: A, name: `r${i}`, type: 'validation', status: 'draft', priority: 1, conditions: [], action: { message: 'x' } })));
    await expect(mk({ name: 'one more', type: 'validation', action: { message: 'x' } })).rejects.toThrow(/At most 50/);
  });

  it('enforcement: a block rule stops the checkout with the seller\'s message; draft rules and other stores\' rules do nothing', async () => {
    await mk({ name: 'Max 3', type: 'validation', conditions: [{ field: 'maxLineQuantity', op: 'gt', value: 3 }], action: { message: 'You can buy at most 3 of one item.' } });
    await svc.create(A, seller, { name: 'Draft', type: 'validation', status: 'draft', conditions: [], action: { message: 'Draft message' } });
    await mk({ name: 'Other store', type: 'validation', conditions: [], action: { message: 'Other store rule' } }, B);
    await expect(svc.enforceCheckout(checkoutOf(A, 4), 'u1')).rejects.toThrow('You can buy at most 3 of one item.');
    await expect(svc.enforceCheckout(checkoutOf(A, 3), 'u1')).resolves.toBeUndefined();
  });

  it('enforcement by delivery address: a restricted region is refused once the address is known', async () => {
    await mk({ name: 'No export', type: 'validation', conditions: [{ field: 'country', op: 'not_in', value: ['Pakistan'] }], action: { message: 'We only deliver inside Pakistan.' } });
    const pk: any = await m.addresses.create({ userId: 'u1', country: 'Pakistan', city: 'Karachi' });
    const uk: any = await m.addresses.create({ userId: 'u1', country: 'United Kingdom', city: 'London' });
    await expect(svc.enforceCheckout(checkoutOf(A, 1, { addressId: String(pk._id) }), 'u1')).resolves.toBeUndefined();
    await expect(svc.enforceCheckout(checkoutOf(A, 1, { addressId: String(uk._id) }), 'u1')).rejects.toThrow('We only deliver inside Pakistan.');
    await expect(svc.enforceCheckout(checkoutOf(A, 1), 'u1')).resolves.toBeUndefined();
    // another customer's address id cannot be used to evaluate (scoped by userId)
    await expect(svc.enforceCheckout(checkoutOf(A, 1, { addressId: String(uk._id) }), 'someone-else')).resolves.toBeUndefined();
  });

  it('enforcement of payment method and delivery option: a hidden one is refused server-side', async () => {
    await mk({ name: 'No COD for big orders', type: 'payment', conditions: [{ field: 'subtotal', op: 'gt', value: 500 }], action: { mode: 'hide', methods: ['cash_on_delivery'] } });
    await expect(svc.enforceCheckout(checkoutOf(A, 6), 'u1', { paymentMethod: 'cash_on_delivery' })).rejects.toThrow(/payment method is not available/);
    await expect(svc.enforceCheckout(checkoutOf(A, 6), 'u1', { paymentMethod: 'stripe' })).resolves.toBeUndefined();
    await expect(svc.enforceCheckout(checkoutOf(A, 1), 'u1', { paymentMethod: 'cash_on_delivery' })).resolves.toBeUndefined();
    const z1 = new mongoose.Types.ObjectId(); const z2 = new mongoose.Types.ObjectId();
    const zones = [{ _id: z1, name: 'Standard', zoneType: 'shipping' }, { _id: z2, name: 'Express', zoneType: 'shipping' }];
    await mk({ name: 'No express small', type: 'shipping', conditions: [{ field: 'subtotal', op: 'lt', value: 300 }], action: { mode: 'hide', zoneIds: [String(z2)] } });
    await expect(svc.enforceCheckout(checkoutOf(A, 1), 'u1', { zoneIds: [String(z2)], zonesOfStore: { [A]: zones } })).rejects.toThrow(/delivery option/);
    await expect(svc.enforceCheckout(checkoutOf(A, 1), 'u1', { zoneIds: [String(z1)], zonesOfStore: { [A]: zones } })).resolves.toBeUndefined();
    await expect(svc.enforceCheckout(checkoutOf(A, 4), 'u1', { zoneIds: [String(z2)], zonesOfStore: { [A]: zones } })).resolves.toBeUndefined();
  });

  it('customer facts come from THIS store\'s user: tags drive B2B / tag conditions, guests are flagged', async () => {
    const u: any = await m.users.create({ storeId: A, tags: ['B2B', 'vip'] });
    const g: any = await m.users.create({ storeId: A, isGuest: true });
    expect(await svc.customerFacts(A, String(u._id))).toMatchObject({ isB2B: true, customerTags: ['B2B', 'vip'], isGuest: false });
    expect(await svc.customerFacts(A, String(g._id))).toMatchObject({ isGuest: true, isB2B: false });
    expect(await svc.customerFacts(B, String(u._id))).toMatchObject({ customerTags: [], isB2B: false });
    expect((await svc.customerFacts(A, null)).isGuest).toBe(true);
  });

  it('cart preview and the seller test tool run the SAME evaluation as checkout', async () => {
    await mk({ name: 'Ten off 3+', type: 'discount', conditions: [{ field: 'itemCount', op: 'gte', value: 3 }], action: disc({ value: 10, label: 'Buy 3 save 10%' }) });
    await mk({ name: 'Hide COD', type: 'payment', action: { mode: 'hide', methods: ['cash_on_delivery'] } });
    const u: any = await m.users.create({ storeId: A });
    await m.carts.create({ userId: String(u._id), storeId: A, items: [{ productId: p1, quantity: 3, price: 100 }] });
    const pv: any = await svc.previewCart(A, String(u._id));
    expect(pv.discount.total).toBe(30); expect(pv.discount.applied[0].label).toBe('Buy 3 save 10%'); expect(pv.hiddenPaymentMethods).toEqual(['cash_on_delivery']);
    expect((await svc.previewCart(B, String(u._id))).discount.total).toBe(0);
    const t: any = await svc.test(A, { sample: { lines: [{ productId: p1, quantity: 3, total: 300 }] }, methods: ['stripe', 'cash_on_delivery'] });
    expect(t.discount.total).toBe(30); expect(t.paymentMethods).toEqual(['stripe']);
    await svc.create(A, seller, { name: 'Draft rule', type: 'validation', status: 'draft', action: { message: 'Draft block' } });
    expect((await svc.test(A, { sample: { lines: [{ productId: p1, quantity: 1, total: 100 }] } }) as any).blocks).toHaveLength(0);
    expect((await svc.test(A, { sample: { lines: [{ productId: p1, quantity: 1, total: 100 }] }, includeDrafts: true }) as any).blocks).toHaveLength(1);
    await expect(svc.test(A, { sample: { lines: [] } })).rejects.toThrow(/at least one/);
  });
});
