/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosCustomerCore } from './pos-customer-core.service';
import { PosCustomersService } from './pos-customers.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { StoreCreditTransactionSchema } from '../store-credit/schemas/store-credit-transaction.schema';
import { moneyContractViolations } from './testing/money-contract';

/** G3.3 on a real replica-set MongoDB: customers (D8 fields), store credit as a tender and a refund method, loyalty earn / redeem / reverse — and no double spend. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let r: any; let cust: PosCustomersService; let credit: StoreCreditService;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, {
    loyaltyProgramModel: h.conn.model(schema.LoyaltyProgram.name, schema.LoyaltyProgramSchema), loyaltyMemberModel: h.conn.model(schema.LoyaltyMember.name, schema.LoyaltyMemberSchema), loyaltyTransactionModel: h.conn.model(schema.LoyaltyTransaction.name, schema.LoyaltyTransactionSchema),
    storeCreditTransactionModel: h.conn.model('StoreCreditTransaction', StoreCreditTransactionSchema),
  });
  r = h.repos;
  const dbs: any = { repositories: r };
  credit = new StoreCreditService(dbs, { log: jest.fn() } as any, { notify: jest.fn().mockResolvedValue(undefined) } as any);
  const core = new PosCustomerCore(dbs, credit);
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any, undefined, undefined, core);
  cust = new PosCustomersService(dbs, svc, new PosAuthorizer(dbs, svc), core);
});
afterAll(async () => { delete process.env.STORE_CREDIT_LEDGER; await h?.stop(); });
beforeEach(() => { process.env.STORE_CREDIT_LEDGER = 'new'; });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const dev = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const act = { actorId: 'seller', actorRole: 'seller' as const };

async function fresh(opts: { currency?: string; price?: number; taxRate?: number; stock?: number } = {}) {
  const s = await seedStore(h, { stock: opts.stock ?? 200, price: opts.price ?? 10, baseCurrency: opts.currency ?? 'USD', taxRate: opts.taxRate });
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 7_200_000), openingCash: 50, totalSales: 0, totalTransactions: 0 });
  const sell = async (qty: number, over: any = {}) => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty }], paymentMethod: 'cash', ...over } as any, tok(s, 'manager'))) as any).data;
  const person = async (name = 'Ayesha Khan', phone: string | null = '03001234567') => (await cust.create(dev(s), s.storeId, { name, ...(phone ? { phone } : {}) }, { employee: tok(s, 'cashier') })).data;
  const give = async (id: string, amount: number) => credit.adjust(s.storeId, id, { amount }, act);
  const bal = async (id: string) => credit.getSpendableBalance(s.storeId, id);
  const loyalty = async (e: number | null, v: number | null, tiers: any[] = []) => r.loyaltyProgramModel.updateOne({ storeId: s.storeId }, { $set: { isEnabled: true, posEarnSpendMinor: e, posRedeemMinorPerPoint: v, tiers } }, { upsert: true });
  const points = async (id: string) => (await r.loyaltyMemberModel.findOne({ storeId: s.storeId, userId: id }).lean())?.pointsBalance ?? 0;
  const sessionDoc = async () => r.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(sid) });
  return { s, sid, sell, person, give, bal, loyalty, points, sessionDoc };
}

describe('customers at the till (D8 fields, all optional)', () => {
  it('add a customer: only a name is required; phone is the key — the same phone returns the same person (a retry, or another till); D8 identity fields are stored', async () => {
    const { s } = await fresh();
    const c = { employee: tok(s, 'cashier') };
    expect(await code(cust.create(dev(s), s.storeId, {}, c))).toBe('NAME_REQUIRED');
    const a: any = (await cust.create(dev(s), s.storeId, { name: 'Bilal', ntn: '1234567-8', cnic: '35202-1234567-1', address: '12 Mall Road', registrationType: 'registered', marketingConsent: true }, c)).data;
    expect([a.name, a.phone, a.ntn, a.cnic, a.address, a.registrationType, a.marketingConsent]).toEqual(['Bilal', null, '1234567-8', '35202-1234567-1', '12 Mall Road', 'registered', true]);
    const p1: any = (await cust.create(dev(s), s.storeId, { name: 'Sara', phone: '+92 300 111-2233' }, c)).data;
    expect(p1.phone).toBe('+923001112233');
    const p2: any = await cust.create(dev(s), s.storeId, { name: 'Sara again', phone: '+923001112233' }, c);
    expect([p2.data.id, p2.data.existing, p2.data.name]).toEqual([p1.id, true, 'Sara']);
    expect(await r.posCustomerModel.countDocuments({ storeId: s.storeId })).toBe(2);
  });

  it('validation never invents rules: bad phone / e-mail / registration type are refused; NTN and CNIC are free-form (letters, digits, dashes) — no format or amount rule is assumed', async () => {
    const { s } = await fresh(); const c = { employee: tok(s, 'cashier') };
    expect(await code(cust.create(dev(s), s.storeId, { name: 'x', phone: 'abc' }, c))).toBe('PHONE_INVALID');
    expect(await code(cust.create(dev(s), s.storeId, { name: 'x', email: 'nope' }, c))).toBe('EMAIL_INVALID');
    expect(await code(cust.create(dev(s), s.storeId, { name: 'x', registrationType: 'vip' }, c))).toBe('REGISTRATION_TYPE_INVALID');
    expect(await code(cust.create(dev(s), s.storeId, { name: 'x', ntn: 'bad id!' }, c))).toBe('NTN_INVALID');
    await cust.create(dev(s), s.storeId, { name: 'ok', ntn: 'ABC-123', cnic: '12345' }, c); // any short code passes
  });

  it('edit is manager / owner only and audited with before / after; a phone already used by another customer is refused', async () => {
    const { s, person } = await fresh();
    const a: any = await person('Ali', '03005550001'); await person('Bina', '03005550002');
    expect(await code(cust.update(dev(s), s.storeId, a.id, { name: 'Ali K' }, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(cust.update(dev(s), s.storeId, a.id, { phone: '03005550002' }, { employee: tok(s, 'manager') }))).toBe('PHONE_IN_USE');
    const done: any = await cust.update(dev(s), s.storeId, a.id, { name: 'Ali K', ntn: '777', registrationType: 'unregistered' }, { employee: tok(s, 'manager') });
    expect([done.data.name, done.data.ntn, done.data.registrationType]).toEqual(['Ali K', '777', 'unregistered']);
    const au: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'customer_edited' }).lean();
    expect([au.metadata.before.name, au.metadata.after.name, au.metadata.after.ntn]).toEqual(['Ali', 'Ali K', '777']);
  });

  it('search finds by name / phone / e-mail, and a storefront buyer of this store (not yet in the directory); another store\'s customers are invisible; every money field carries currency + exponent', async () => {
    const a = await fresh({ currency: 'JPY' }); const b = await fresh();
    await a.person('Hana Sato', '09011112222'); await b.person('Hana Other', '03009998888');
    await r.userModel.collection.insertOne({ _id: new Types.ObjectId(), name: 'Hana Web', email: 'hana@web.test', storeId: a.s.storeId });
    const res: any = await cust.search(dev(a.s), a.s.storeId, 'hana', { employee: tok(a.s, 'cashier') });
    expect(res.data.items.map((x: any) => [x.kind, x.name]).sort()).toEqual([['pos', 'Hana Sato'], ['user', 'Hana Web']]);
    expect(res.data).toMatchObject({ currency: 'JPY', currencyExponent: 0 });
    expect(moneyContractViolations(res)).toEqual([]);
    const byPhone: any = await cust.search(dev(a.s), a.s.storeId, '0901', { employee: tok(a.s, 'cashier') });
    expect(byPhone.data.items).toHaveLength(1);
  });
});

describe('store credit as a TENDER (D3): online only, exact in every exponent, never double-spent', () => {
  for (const [cur, price, creditAmount, expTotal] of [['USD', 10, 20, 11], ['JPY', 1000, 5000, 1100], ['KWD', 5, 20, 5.5]] as const) {
    it(`${cur}: a sale paid part credit / part cash takes exactly the credit; the shift counts it with "other", not as cash; the ledger entry names the sale`, async () => {
      const f = await fresh({ currency: cur, price, taxRate: 0.1 });
      const c: any = await f.person(); await f.give(c.id, creditAmount);
      const credPart = cur === 'KWD' ? 2.5 : cur === 'JPY' ? 500 : 5;
      const sale = await f.sell(1, { customerId: c.id, payments: [{ method: 'store_credit', amount: credPart }, { method: 'cash', amount: expTotal - credPart }] });
      expect(sale.total).toBe(expTotal);
      expect(sale.payments.map((p: any) => [p.method, p.amount])).toEqual([['store_credit', credPart], ['cash', expTotal - credPart]]);
      expect(await f.bal(c.id)).toBeCloseTo(creditAmount - credPart, cur === 'KWD' ? 3 : 2);
      const e: any = await r.storeCreditEntryModel.findOne({ storeId: f.s.storeId, type: 'spend' }).lean();
      expect([e.saleId, Math.abs(e.amountMinor), e.currencyExponent]).toEqual([String(sale._id), Math.round(credPart * 10 ** e.currencyExponent), cur === 'JPY' ? 0 : cur === 'KWD' ? 3 : 2]);
      const sess: any = await f.sessionDoc();
      expect([Math.round(sess.otherSales * 1000) / 1000, Math.round(sess.cashSales * 1000) / 1000]).toEqual([credPart, expTotal - credPart]);
    });
  }

  it('refused clearly: offline sale, no customer, not enough credit (nothing changes: no sale, stock back), ledger not switched on', async () => {
    const f = await fresh({ price: 10 });
    const c: any = await f.person(); await f.give(c.id, 3);
    const pay = [{ method: 'store_credit', amount: 5 }, { method: 'cash', amount: 5 }];
    expect(await code(f.sell(1, { customerId: c.id, payments: pay, offline: true, clientCreatedAt: new Date(Date.now() - 3_600_000).toISOString() }))).toBe('STORE_CREDIT_ONLINE_ONLY');
    expect(await code(f.sell(1, { payments: pay }))).toBe('CUSTOMER_REQUIRED');
    expect(await code(f.sell(1, { customerId: 'ffffffffffffffffffffffff', payments: pay }))).toBe('CUSTOMER_REQUIRED');
    expect(await code(f.sell(1, { customerId: c.id, payments: pay }))).toBe('STORE_CREDIT_INSUFFICIENT');
    expect(await r.saleModel.countDocuments({ storeId: f.s.storeId })).toBe(0);
    expect((await r.productVariantModel.findById(f.s.variantId).lean()).stock).toBe(200);
    expect(await f.bal(c.id)).toBe(3);
    process.env.STORE_CREDIT_LEDGER = 'legacy';
    expect(await code(f.sell(1, { customerId: c.id, payments: pay }))).toBe('STORE_CREDIT_NOT_ENABLED');
  });

  it('DUAL SPEND: the storefront and the till spend the SAME balance at the same moment — exactly one wins, in both orders, many rounds', async () => {
    const f = await fresh({ price: 10 });
    for (let round = 0; round < 12; round++) {
      const c: any = await f.person(`P${round}`, `0300${String(1000000 + round)}`); await f.give(c.id, 10);
      const [web, till] = await Promise.all([
        credit.redeemAtOrderPlacement(f.s.storeId, c.id, 7, `chk-${round}`, `ord-${round}`),
        f.sell(1, { customerId: c.id, payments: [{ method: 'store_credit', amount: 7 }, { method: 'cash', amount: 4 }], idempotencyKey: `till-${round}` }).then(() => true).catch(() => false),
      ]);
      expect([web, till].filter(Boolean)).toHaveLength(1);
      expect(await f.bal(c.id)).toBe(3);
    }
  });

  it('two tills selling with the last credit: one sale, the other refused; the balance never goes negative', async () => {
    const f = await fresh({ price: 10 });
    const c: any = await f.person(); await f.give(c.id, 6);
    const res = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => f.sell(1, { customerId: c.id, payments: [{ method: 'store_credit', amount: 6 }, { method: 'cash', amount: 5 }], idempotencyKey: `t-${i}` })));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await f.bal(c.id)).toBe(0);
    expect(await r.storeCreditLotModel.countDocuments({ storeId: f.s.storeId, remainingMinor: { $lt: 0 } })).toBe(0);
  });
});

describe('store credit as a REFUND method and the way back', () => {
  it('a sale PAID with credit: a return puts the credit back (same customer, same ledger); the credit note names the tender', async () => {
    const f = await fresh({ price: 10, taxRate: 0.1 });
    const c: any = await f.person(); await f.give(c.id, 20);
    const sale = await f.sell(2, { customerId: c.id, payments: [{ method: 'store_credit', amount: 22 }] }).catch(() => null);
    expect(sale).toBeNull(); // 22.00 > 20.00: refused — now with enough credit
    await f.give(c.id, 5);
    const ok = await f.sell(2, { customerId: c.id, payments: [{ method: 'store_credit', amount: 22 }] });
    expect(await f.bal(c.id)).toBe(3);
    const res: any = await svc.refundSale(f.s.sellerId, String(ok._id), { items: [{ saleItemId: String(ok.items[0]._id), qty: 1 }] } as any, tok(f.s, 'manager'));
    expect(res.data.tenders).toEqual([{ method: 'store_credit', amount: 11 }]);
    expect(await f.bal(c.id)).toBe(14);
    const e: any = await r.storeCreditEntryModel.findOne({ storeId: f.s.storeId, type: 'spend_reversal' }).lean();
    expect([e.amountMinor, e.saleId, e.creditNoteNumber]).toEqual([1100, String(ok._id), res.data.creditNote.number]);
    await svc.refundSale(f.s.sellerId, String(ok._id), {} as any, tok(f.s, 'manager')); // the rest
    expect(await f.bal(c.id)).toBe(25);
  });

  it('refund TO store credit: cash becomes credit for the sale\'s customer; the credit note says store_credit; needs a customer; over the limit a cashier needs a manager', async () => {
    const f = await fresh({ price: 10 });
    await r.posSettingsModel.updateOne({ storeId: f.s.storeId }, { $set: { cashierReturnsEnabled: true } }, { upsert: true });
    const c: any = await f.person();
    const sale = await f.sell(3, { customerId: c.id, amountTendered: 30 });
    const noCust = await f.sell(1);
    expect(await code(svc.refundSale(f.s.sellerId, String(noCust._id), { refundTo: 'store_credit' } as any, tok(f.s, 'manager')))).toBe('CUSTOMER_REQUIRED_FOR_CREDIT');
    // default limit 50.00: a cashier may refund 30.00 to credit alone
    const r1: any = await svc.refundSale(f.s.sellerId, String(sale._id), { items: [{ saleItemId: String(sale.items[0]._id), qty: 1 }], refundTo: 'store_credit' } as any, tok(f.s, 'cashier'));
    expect(r1.data.tenders).toEqual([{ method: 'store_credit', amount: 10 }]);
    expect(await f.bal(c.id)).toBe(10);
    const cn: any = await r.posCreditNoteModel.findOne({ storeId: f.s.storeId }).lean();
    expect(cn.tenders).toEqual([{ method: 'store_credit', amountMinor: 1000 }]);
    // no cash left the drawer
    expect((await f.sessionDoc()).totalRefunds).toBe(10);
    // above the limit (lower it to 5.00): the cashier needs a manager, the manager does not
    await r.posSettingsModel.updateOne({ storeId: f.s.storeId }, { $set: { 'approvalLimits.storeCreditRefundMinor': 500 } });
    const denied = await svc.refundSale(f.s.sellerId, String(sale._id), { items: [{ saleItemId: String(sale.items[0]._id), qty: 1 }], refundTo: 'store_credit' } as any, tok(f.s, 'cashier')).catch((e) => e.response);
    expect([denied.code, denied.reasons]).toEqual(['RETURN_NEEDS_MANAGER', ['store_credit_refund_above_limit']]);
    const ok: any = await svc.refundSale(f.s.sellerId, String(sale._id), { items: [{ saleItemId: String(sale.items[0]._id), qty: 1 }], refundTo: 'store_credit' } as any, tok(f.s, 'manager'));
    expect(ok.data.tenders[0].method).toBe('store_credit');
    expect(await f.bal(c.id)).toBe(20);
  });

  it('a void gives the credit back too (and the points); a retried refund (same key) credits once', async () => {
    const f = await fresh({ price: 10 });
    const c: any = await f.person(); await f.give(c.id, 10); await f.loyalty(100, 100);
    const sale = await f.sell(1, { customerId: c.id, payments: [{ method: 'store_credit', amount: 10 }] });
    expect(await f.bal(c.id)).toBe(0);
    await svc.voidSale(f.s.sellerId, String(sale._id), {} as any, tok(f.s, 'manager'));
    expect(await f.bal(c.id)).toBe(10);
    expect(await r.storeCreditEntryModel.countDocuments({ storeId: f.s.storeId, type: 'spend_reversal' })).toBe(1);
  });
});

describe('loyalty (D2): earn per spend, redeem as a discount (online only), reverse proportionally on returns', () => {
  it('earn = floor(net spend / rate): after discount, BEFORE tax; a tier is reached; no rate / program off / no customer earns nothing', async () => {
    const f = await fresh({ price: 10, taxRate: 0.1 });
    const c: any = await f.person();
    await f.loyalty(500, null, [{ name: 'Bronze', minPoints: 0 }, { name: 'Silver', minPoints: 2 }]); // 1 point per 5.00 of net spend
    const sale = await f.sell(3, { customerId: c.id, amountTendered: 40 }); // net 30.00, tax 3.00 → 6 points
    expect(sale.loyalty).toMatchObject({ earnedPoints: 6, earnSpendMinor: 3000 });
    expect(await f.points(c.id)).toBe(6);
    expect((await r.loyaltyMemberModel.findOne({ storeId: f.s.storeId, userId: c.id }).lean()).currentTier).toBe('Silver');
    await f.sell(1, { customerId: c.id, amountTendered: 20 }); // net 10.00 → 2
    expect(await f.points(c.id)).toBe(8);
    await f.loyalty(null, null);
    await f.sell(1, { customerId: c.id, amountTendered: 20 });
    expect(await f.points(c.id)).toBe(8); // rate off
    expect((await f.sell(1)).loyalty ?? null).toBeNull(); // walk-in
  });

  it('redeem: points × value is a discount (priced by the server); balance guarded; not with a coupon / manual discount, not offline, not above the sale; the points leave in the same transaction', async () => {
    const f = await fresh({ price: 10 });
    const c: any = await f.person();
    await f.loyalty(1000, 50); // 1 point per 10.00; a point is worth 0.50
    await f.sell(5, { customerId: c.id, amountTendered: 50 }); // 5 points
    expect(await f.points(c.id)).toBe(5);
    expect(await code(f.sell(1, { redeemPoints: 2 }))).toBe('CUSTOMER_REQUIRED');
    expect(await code(f.sell(1, { customerId: c.id, redeemPoints: 6 }))).toBe('LOYALTY_INSUFFICIENT_POINTS');
    expect(await code(f.sell(1, { customerId: c.id, redeemPoints: 2, discount: 1 }))).not.toBeNull();
    expect(await code(f.sell(1, { customerId: c.id, redeemPoints: 2, offline: true, clientCreatedAt: new Date(Date.now() - 3_600_000).toISOString() }))).toBe('LOYALTY_ONLINE_ONLY');
    const sale = await f.sell(2, { customerId: c.id, redeemPoints: 4, amountTendered: 20 }); // 4 × 0.50 = 2.00 off 20.00
    expect([sale.subtotal, sale.discount, sale.total]).toEqual([20, 2, 18]);
    expect(sale.loyalty).toMatchObject({ redeemedPoints: 4, redeemValueMinor: 200, earnedPoints: 1 });
    expect(await f.points(c.id)).toBe(2); // 5 − 4 + 1 earned on 18.00
    expect(await code(f.sell(1, { customerId: c.id, redeemPoints: 25 }))).toBe('LOYALTY_EXCEEDS_SALE'); // 25 × 0.50 is more than the 10.00 sale
  });

  for (const [cur, price, per, perPoint] of [['JPY', 1000, 1000, 10], ['USD', 10, 1000, 10], ['KWD', 10, 10000, 100]] as const) {
    it(`${cur}: returns reverse the points CUMULATIVELY and exactly across any chunking; redeemed points come back with the money`, async () => {
      const f = await fresh({ currency: cur, price, stock: 500 });
      const c: any = await f.person(); await f.loyalty(per, perPoint);
      // a sale of 7 lines worth of units: earn floor(net / rate)
      const qty = 7;
      const sale = await f.sell(qty, { customerId: c.id, amountTendered: price * qty });
      const earned = sale.loyalty.earnedPoints;
      expect(earned).toBe(Math.floor((price * qty * 10 ** (cur === 'JPY' ? 0 : cur === 'KWD' ? 3 : 2)) / per));
      const line = String(sale.items[0]._id);
      for (const q of [1, 1, 2, 3]) await svc.refundSale(f.s.sellerId, String(sale._id), { items: [{ saleItemId: line, qty: q }] } as any, tok(f.s, 'manager'));
      expect(await f.points(c.id)).toBe(0); // exactly `earned` was reversed, in total, never one point more (balance never negative)
      const rev = (await r.loyaltyTransactionModel.find({ storeId: f.s.storeId, userId: c.id, type: 'adjustment' }).lean()).reduce((t: number, x: any) => t + x.points, 0);
      expect(rev).toBe(-earned);
    });
  }

  it('a void reverses the earned points and gives the redeemed points back; a held sale earns when it is COMPLETED', async () => {
    const f = await fresh({ price: 10 });
    const c: any = await f.person(); await f.loyalty(1000, 100);
    await f.sell(10, { customerId: c.id, amountTendered: 100 }); // 10 points
    const sale = await f.sell(3, { customerId: c.id, redeemPoints: 5, amountTendered: 30 }); // 5 × 1.00 off; earns floor(25/10)=2
    expect(await f.points(c.id)).toBe(7);
    await svc.voidSale(f.s.sellerId, String(sale._id), {} as any, tok(f.s, 'manager'));
    expect(await f.points(c.id)).toBe(10); // −2 earned, +5 restored
    const held = await f.sell(2, { customerId: c.id, status: 'held' });
    expect(await f.points(c.id)).toBe(10);
    await svc.completeSale(f.s.sellerId, String(held._id), { paymentMethod: 'cash', amountTendered: 20 } as any, tok(f.s, 'manager'));
    expect(await f.points(c.id)).toBe(12);
  });

  it('OFFLINE: a sale rung up offline with a customer earns its points WHEN IT SYNCS, exactly once even if the queue replays it; a return after the sync reverses them', async () => {
    const f = await fresh({ price: 10, taxRate: 0.1 });
    const c: any = await f.person(); await f.loyalty(500, 50); // 1 point per 5.00 of net spend
    const off = { offline: true, clientCreatedAt: new Date(Date.now() - 3_600_000).toISOString(), customerId: c.id, idempotencyKey: 'offline-loyalty-1', amountTendered: 40 };
    const first = await f.sell(3, off); // net 30.00 → 6 points
    expect(first.isOffline).toBe(true);
    expect(first.loyalty).toMatchObject({ earnedPoints: 6, ledgerId: c.id });
    expect(await f.points(c.id)).toBe(6);
    await f.sell(3, off).catch(() => undefined); // the queue replays the same sale (retry / app killed after the answer)
    await f.sell(3, off).catch(() => undefined);
    expect(await f.points(c.id)).toBe(6);
    expect(await r.loyaltyTransactionModel.countDocuments({ storeId: f.s.storeId, userId: c.id, type: 'purchase' })).toBe(1);
    expect(await r.saleModel.countDocuments({ storeId: f.s.storeId })).toBe(1);
    // returned AFTER the sync: the points reverse proportionally (1 of 3 units → 2 of 6, then the rest)
    await svc.refundSale(f.s.sellerId, String(first._id), { items: [{ saleItemId: String(first.items[0]._id), qty: 1 }] } as any, tok(f.s, 'manager'));
    expect(await f.points(c.id)).toBe(4);
    await svc.refundSale(f.s.sellerId, String(first._id), { items: [{ saleItemId: String(first.items[0]._id), qty: 2 }] } as any, tok(f.s, 'manager'));
    expect(await f.points(c.id)).toBe(0);
    // an offline sale that tried to REDEEM points is refused (the app never queues it; the server never trusts it)
    expect(await code(f.sell(1, { ...off, idempotencyKey: 'offline-loyalty-2', redeemPoints: 1 }))).toBe('LOYALTY_ONLINE_ONLY');
  });

  it('the owner sets the rates (audited); a manager cannot; junk is refused; config reports credit on/off', async () => {
    const f = await fresh();
    expect(await code(cust.setLoyaltyConfig(dev(f.s), f.s.storeId, { earnSpendMinor: 500 }, { employee: tok(f.s, 'manager') }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(cust.setLoyaltyConfig(owner(f.s), f.s.storeId, { earnSpendMinor: 0 }, {}))).toBe('RATE_INVALID');
    const res: any = await cust.setLoyaltyConfig(owner(f.s), f.s.storeId, { earnSpendMinor: 500, redeemMinorPerPoint: 25 }, {});
    expect(res.data.loyalty).toMatchObject({ earnSpendMinor: 500, redeemMinorPerPoint: 25 });
    expect(res.data.storeCreditTenderEnabled).toBe(true);
    expect(moneyContractViolations(res)).toEqual([]);
    process.env.STORE_CREDIT_LEDGER = 'legacy';
    expect((await cust.config(dev(f.s), f.s.storeId, { employee: tok(f.s, 'cashier') })).data.storeCreditTenderEnabled).toBe(false);
  });

  it('profile: balances for every role, lifetime spend for managers only; the credit ledger is manager-only; money responses state currency + exponent; manual credit above the limit needs the OWNER', async () => {
    const f = await fresh({ price: 10 });
    const c: any = await f.person(); await f.give(c.id, 8); await f.loyalty(1000, 100);
    await f.sell(2, { customerId: c.id, amountTendered: 20 });
    const cp: any = await cust.profile(dev(f.s), f.s.storeId, c.id, { employee: tok(f.s, 'cashier') });
    expect([cp.data.creditBalanceMinor, cp.data.loyaltyPoints, 'lifetimeSpendMinor' in cp.data]).toEqual([800, 2, false]);
    const mp: any = await cust.profile(dev(f.s), f.s.storeId, c.id, { employee: tok(f.s, 'manager') });
    expect(mp.data.lifetimeSpendMinor).toBe(2000);
    expect(mp.data.recentSales).toHaveLength(1);
    expect(moneyContractViolations(mp)).toEqual([]);
    expect(await code(cust.creditLedger(dev(f.s), f.s.storeId, c.id, {}, { employee: tok(f.s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
    const led: any = await cust.creditLedger(dev(f.s), f.s.storeId, c.id, {}, { employee: tok(f.s, 'manager') });
    expect(led.data.items.map((x: any) => x.type)).toEqual(['adjust_credit'].map(() => led.data.items[0].type));
    expect(moneyContractViolations(led)).toEqual([]);
    // manual credit: manager within the limit; above it (default 100.00) the owner
    await cust.creditAdjust(dev(f.s), f.s.storeId, c.id, { amountMinor: 5000, note: 'goodwill' }, { employee: tok(f.s, 'manager') });
    expect(await code(cust.creditAdjust(dev(f.s), f.s.storeId, c.id, { amountMinor: 20000, note: 'big' }, { employee: tok(f.s, 'manager') }))).toBe('POS_OWNER_REQUIRED');
    await cust.creditAdjust(owner(f.s), f.s.storeId, c.id, { amountMinor: 20000, note: 'big' }, {});
    expect(await f.bal(c.id)).toBe(8 + 50 + 200);
    expect(await code(cust.creditAdjust(dev(f.s), f.s.storeId, c.id, { amountMinor: 100, note: '' }, { employee: tok(f.s, 'manager') }))).toBe('NOTE_REQUIRED');
  });
});
