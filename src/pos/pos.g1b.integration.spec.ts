/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosMinorMetrics } from './pos-minor-metrics';
import { checkMinorPairs, toMinor } from '../common/money-minor.util';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/**
 * G1b (steps a, b, d, e-server) on a REAL replica-set MongoDB: every create/update path dual-writes decimal + integer minor,
 * the checker catches an injected mismatch without failing the sale, open shifts get their minor counters from the decimal in the
 * same atomic update, and old payloads (no minor fields) keep working next to new ones.
 */
jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); jest.restoreAllMocks(); PosMinorMetrics.reset(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tokenFor = (s: Seed, who: 'manager' | 'cashier') =>
  jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const openSession = async (svc: PosService, s: Seed, over: any = {}) => String(((await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 100, ...over } as any)) as any).data._id);
const saleDto = (s: Seed, sid: string, over: any = {}) => ({
  storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId,
  items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], paymentMethod: 'cash', ...over,
});
const rawSale = async (id: any): Promise<any> => h.repos.saleModel.collection.findOne({ _id: new Types.ObjectId(String(id)) });
const rawSession = async (id: string): Promise<any> => h.repos.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(id) });
const code = async (p: Promise<any>) => { try { await p; return 'NO_ERROR'; } catch (e: any) { return e.getResponse?.().code ?? e.message; } };
const num = (v: any) => (v && typeof v.toNumber === 'function' ? v.toNumber() : v); // raw driver reads may hand back a Long
const bsonTypes = async (coll: any, id: any, paths: string[]) => {
  const proj: any = {}; paths.forEach((p, i) => { proj['t' + i] = { $type: '$' + p }; });
  const [r] = await coll.aggregate([{ $match: { _id: id } }, { $project: proj }]).toArray();
  return paths.map((_, i) => r['t' + i]);
};
const mismatches = (doc: any, kind: 'sale' | 'session', exp = 2) => checkMinorPairs(doc, PosService.MINOR_PAIRS[kind], exp);
const auditCount = (storeId: string, action: string) => h.repos.posAuditLogModel.countDocuments({ storeId, action });

describe('dual-write: sales', () => {
  it('cash sale: every money field has its integer twin, stored as long, and the checker is clean', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10, taxRate: 0.1 });
    const sid = await openSession(svc, s);
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid, { amountTendered: 50 }) as any, undefined);
    const doc = await rawSale(res.data._id);
    expect({ subtotal: doc.subtotal, tax: doc.tax, total: doc.total, change: doc.changeGiven }).toEqual({ subtotal: 20, tax: 2, total: 22, change: 28 });
    expect([doc.subtotalMinor, doc.taxMinor, doc.totalMinor, doc.changeGivenMinor, doc.discountMinor, doc.paymentShortfallMinor].map(num)).toEqual([2000, 200, 2200, 2800, 0, 0]);
    expect([doc.items[0].priceMinor, doc.items[0].lineTotalMinor].map(num)).toEqual([1000, 2000]);
    expect([doc.payments[0].amountMinor, doc.payments[0].tenderedMinor].map(num)).toEqual([2200, 5000]);
    expect(await bsonTypes(h.repos.saleModel.collection, doc._id, ['totalMinor', 'items.lineTotalMinor', 'payments.amountMinor'])).toEqual(['long', 'array', 'array']);
    expect(num(doc.refundedAmountMinor)).toBe(0); // complete from the first write
    expect(mismatches(doc, 'sale')).toEqual([]);
    expect(JSON.parse(JSON.stringify(res.data)).totalMinor).toBe(2200); // a plain JSON number on the wire
    expect(PosMinorMetrics.snapshot().totalMismatchedDocs).toBe(0);
    const pay: any = await h.repos.posPaymentModel.collection.findOne({ saleId: String(doc._id) });
    expect([pay.amountMinor, pay.tenderedMinor].map(num)).toEqual([2200, 5000]);
  });

  it('card + split + discount: tender lines, an amount discount and a % discount carry minor correctly', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    const split: any = await svc.createSale(s.sellerId, saleDto(s, sid, { paymentMethod: 'card', payments: [{ method: 'card', amount: 12.34, reference: 'A' }, { method: 'cash', amount: 7.66 }] }) as any, undefined);
    const d1 = await rawSale(split.data._id);
    expect(d1.payments.map((p: any) => num(p.amountMinor))).toEqual([1234, 766]);
    const disc: any = await svc.createSale(s.sellerId, saleDto(s, sid, { discountType: 'amount', discountValue: 3.5, discount: 3.5 }) as any, tokenFor(s, 'manager'));
    const d2 = await rawSale(disc.data._id);
    expect([d2.discountMinor, d2.discountValueMinor, d2.totalMinor].map(num)).toEqual([350, 350, 1650]);
    const pct: any = await svc.createSale(s.sellerId, saleDto(s, sid, { discountType: 'percent', discountValue: 10 }) as any, tokenFor(s, 'manager'));
    const d3 = await rawSale(pct.data._id);
    expect(num(d3.discountMinor)).toBe(200);
    expect(d3.discountValueMinor).toBeUndefined(); // a percentage is not money
    for (const d of [d1, d2, d3]) expect(mismatches(d, 'sale')).toEqual([]);
  });

  it('lineTotalMinor = toMinor(price × qty) is AUTHORITATIVE: for a sub-minor price priceMinor × qty may differ', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 50, price: 0.125 });
    const sid = await openSession(svc, s);
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] }) as any, undefined);
    const doc = await rawSale(res.data._id);
    expect(num(doc.items[0].priceMinor)).toBe(toMinor(0.125, 2));            // 13 (0.125 → 0.13, half away from zero)
    expect(num(doc.items[0].lineTotalMinor)).toBe(toMinor(0.125 * 3, 2));    // 38 (0.375 → 0.38)
    expect(num(doc.items[0].priceMinor) * 3).not.toBe(num(doc.items[0].lineTotalMinor)); // 39 ≠ 38: the line figure is the one that counts
    expect(num(doc.subtotalMinor)).toBe(38);
    expect(mismatches(doc, 'sale')).toEqual([]);
  });

  it('exponent 0 (JPY) and 3 (KWD) stores convert with their own exponent', async () => {
    for (const [cur, exp, price] of [['JPY', 0, 500], ['KWD', 3, 1.25]] as const) {
      const svc = makeService(); const s = await seedStore(h, { stock: 20, price, baseCurrency: cur });
      const sid = await openSession(svc, s);
      const res: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
      const doc = await rawSale(res.data._id);
      expect(num(doc.totalMinor)).toBe(toMinor(price * 2, exp));
      expect(doc.currencyExponent).toBe(exp);
      expect(mismatches(doc, 'sale', exp)).toEqual([]);
    }
  });

  it('held sale: create, edit, resume (complete) and discard all keep minor in step', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    const held: any = await svc.createSale(s.sellerId, saleDto(s, sid, { status: 'held' }) as any, undefined);
    let doc = await rawSale(held.data._id);
    expect([num(doc.totalMinor), num(doc.changeGivenMinor)]).toEqual([2000, 0]);
    await svc.editHeldSaleItems(s.sellerId, String(held.data._id), { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] } as any, undefined);
    doc = await rawSale(held.data._id);
    expect([num(doc.subtotalMinor), num(doc.items[0].lineTotalMinor)]).toEqual([3000, 3000]);
    const done: any = await svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'cash', amountTendered: 40 } as any, undefined);
    doc = await rawSale(done.data._id);
    expect([doc.status, num(doc.totalMinor), num(doc.changeGivenMinor), num(doc.payments[0].tenderedMinor)]).toEqual(['completed', 3000, 1000, 4000]);
    expect(mismatches(doc, 'sale')).toEqual([]);
    const other: any = await svc.createSale(s.sellerId, saleDto(s, sid, { status: 'held' }) as any, undefined);
    await svc.discardHeldSale(s.sellerId, String(other.data._id), { reason: 'x' });
    expect(mismatches(await rawSale(other.data._id), 'sale')).toEqual([]);
    expect(PosMinorMetrics.snapshot().totalMismatchedDocs).toBe(0);
  });
});

describe('dual-write: refunds, void, shift counters', () => {
  it('full refund, partial refund and void: refund records, refundedAmountMinor and the shift counters stay in step', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 30, price: 10 });
    const sid = await openSession(svc, s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sid, { payments: [{ method: 'card', amount: 20 }], paymentMethod: 'card' }) as any, undefined);
    await svc.refundSale(s.sellerId, String(a.data._id), undefined, tokenFor(s, 'manager'), 'rk-a');
    let doc = await rawSale(a.data._id);
    expect([doc.status, num(doc.refundedAmountMinor), num(doc.refunds[0].amountMinor), num(doc.refunds[0].tenders[0].amountMinor)]).toEqual(['refunded', 2000, 2000, 2000]);
    const rr: any = await h.repos.posRefundModel.collection.findOne({ saleId: String(a.data._id) });
    expect([num(rr.amountMinor), num(rr.tenders[0].amountMinor)]).toEqual([2000, 2000]);

    const b: any = await svc.createSale(s.sellerId, saleDto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] }) as any, undefined);
    const item = (await rawSale(b.data._id)).items[0];
    await svc.refundSale(s.sellerId, String(b.data._id), { items: [{ saleItemId: String(item._id), qty: 1 }] } as any, tokenFor(s, 'manager'), 'rk-b');
    doc = await rawSale(b.data._id);
    expect([doc.status, num(doc.refundedAmountMinor)]).toEqual(['partially_refunded', 1000]);

    const c: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    await svc.voidSale(s.sellerId, String(c.data._id), { reason: 'oops' }, tokenFor(s, 'manager'));

    for (const id of [a.data._id, b.data._id, c.data._id]) expect(mismatches(await rawSale(id), 'sale')).toEqual([]);
    const sess = await rawSession(sid);
    expect(mismatches(sess, 'session')).toEqual([]);
    // net: a (20 card, refunded) + b (30 cash − 10 refunded) + c (20 cash, voided) → cash 20, card 0
    expect([num(sess.cashSalesMinor), num(sess.cardSalesMinor), num(sess.totalSalesMinor), num(sess.totalRefundsMinor)]).toEqual([2000, 0, 2000, 3000]);
    expect(PosMinorMetrics.snapshot().totalMismatchedDocs).toBe(0);
  });

  it('the shift-drift case: card sales of 2.20 + 1.10 leave the DECIMAL counter drifting but the MINOR counter exact', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 50, price: 1.1 });
    const sid = await openSession(svc, s);
    await svc.createSale(s.sellerId, saleDto(s, sid, { paymentMethod: 'card', payments: [{ method: 'card', amount: 2.2 }] }) as any, undefined); // 2 × 1.10
    await svc.createSale(s.sellerId, saleDto(s, sid, { paymentMethod: 'card', payments: [{ method: 'card', amount: 1.1 }], items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }] }) as any, undefined);
    const sess = await rawSession(sid);
    expect(num(sess.cardSalesMinor)).toBe(330);                  // exact
    expect(sess.cardSales).toBeCloseTo(3.3, 10);                  // the decimal may carry 1e-16 of float noise (2.2 + 1.1 = 3.3000000000000003)
    expect(toMinor(sess.cardSales, 2)).toBe(330);                 // …and still converts to exactly 330
    expect(mismatches(sess, 'session')).toEqual([]);              // so the checker does not cry wolf on float noise
  });

  it('a shift that was OPEN when G1b was deployed (counters without minor) is initialised from the decimal in the same atomic update', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    // simulate the pre-G1b state: decimal counters only, no minor fields at all
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, {
      $set: { cashSales: 105.5, cardSales: 40, totalSales: 145.5, totalTransactions: 7, openingCash: 100 },
      $unset: { cashSalesMinor: '', cardSalesMinor: '', otherSalesMinor: '', totalSalesMinor: '', totalRefundsMinor: '', openingCashMinor: '' },
    });
    await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined); // +20 cash
    const sess = await rawSession(sid);
    expect([sess.cashSales, sess.totalSales, sess.totalTransactions]).toEqual([125.5, 165.5, 8]);
    expect([num(sess.cashSalesMinor), num(sess.totalSalesMinor)]).toEqual([12550, 16550]); // baseline 10 550 / 14 550 from the decimals + 2 000
    expect(sess.cardSalesMinor).toBeUndefined(); // counters nobody touched are left for the backfill
    expect(await bsonTypes(h.repos.registerSessionModel.collection, sess._id, ['cashSalesMinor', 'totalSalesMinor'])).toEqual(['long', 'long']);
  });

  it('open, cash in/out, close with a card variance: opening float, adjustments, counted cash and the card variance all carry minor', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s, { openingCash: 150.25 });
    await svc.createSale(s.sellerId, saleDto(s, sid, { paymentMethod: 'card', payments: [{ method: 'card', amount: 20 }] }) as any, undefined);
    await svc.cashInOut(s.sellerId, sid, { type: 'cash_in', amount: 10.5, reason: 'float top-up' } as any, tokenFor(s, 'manager'));
    const closed: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 160, cardTotalFromSlip: 18.5 } as any, tokenFor(s, 'manager'));
    const sess = await rawSession(sid);
    expect(closed.data.status).toBe('closed');
    expect([num(sess.openingCashMinor), num(sess.closingCashMinor), num(sess.expectedCashMinor), num(sess.cashDifferenceMinor)]).toEqual([15025, 16000, 16075, -75]);
    expect(num(sess.cashAdjustments[0].amountMinor)).toBe(1050);
    expect([num(sess.cardReconciliation.slipTotalMinor), num(sess.cardReconciliation.expectedCardMinor), num(sess.cardReconciliation.varianceMinor)]).toEqual([1850, 2000, -150]);
    expect(mismatches(sess, 'session')).toEqual([]);
  });

  it('registers: the default float carries a minor twin in the store currency exponent', async () => {
    const svc = makeService(); const s = await seedStore(h, { baseCurrency: 'KWD' });
    await svc.addRegister(s.sellerId, s.storeId, { name: 'Counter 2', defaultFloatCash: 12.345 });
    await svc.updateRegister(s.sellerId, s.storeId, s.registerId, { defaultFloatCash: 7.5 } as any);
    const store: any = await h.repos.storeModel.collection.findOne({ _id: new Types.ObjectId(s.storeId) });
    const added = store.registers.find((r: any) => r.name === 'Counter 2');
    expect([added.defaultFloatCash, num(added.defaultFloatCashMinor)]).toEqual([12.345, 12345]);
    const updated = store.registers.find((r: any) => String(r._id) === s.registerId);
    expect([updated.defaultFloatCash, num(updated.defaultFloatCashMinor)]).toEqual([7.5, 7500]);
  });
});

describe('the consistency checker', () => {
  it('CATCHES an injected mismatch: logs, writes a money_minor_mismatch audit event, counts it — and the sale still succeeds', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    // inject: break the engine's minor figure for this one write (a bug in a future change)
    const real = (svc as any).saleMoneyMinor.bind(svc);
    jest.spyOn(svc as any, 'saleMoneyMinor').mockImplementation((...a: any[]) => ({ ...real(...a), totalMinor: 9999 }));
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    expect(res.success).toBe(true);                                  // the sale is NEVER failed by the checker
    expect((await rawSale(res.data._id)).status).toBe('completed');
    expect(await auditCount(s.storeId, 'money_minor_mismatch')).toBe(1);
    const [ev]: any[] = await h.repos.posAuditLogModel.find({ storeId: s.storeId, action: 'money_minor_mismatch' }).lean();
    expect(ev.metadata.mismatches[0]).toMatchObject({ path: 'totalMinor', major: 20, minor: 9999, expectedMinor: 2000 });
    expect(ev).toMatchObject({ targetType: 'sale', targetId: String(res.data._id) });
    expect(err.mock.calls.some((c) => String(c[0]).includes('[pos-minor-mismatch] sale'))).toBe(true);
    expect(PosMinorMetrics.snapshot()).toMatchObject({ totalMismatchedDocs: 1, mismatchedDocs: { sale: 1 } });
  });

  it('a failing audit write inside the checker is swallowed (never fails the sale either)', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const real = (svc as any).saleMoneyMinor.bind(svc);
    jest.spyOn(svc as any, 'saleMoneyMinor').mockImplementation((...a: any[]) => ({ ...real(...a), totalMinor: 1 }));
    const original = h.repos.posAuditLogModel.create.bind(h.repos.posAuditLogModel);
    jest.spyOn(h.repos.posAuditLogModel, 'create').mockImplementation(((docs: any, ...rest: any[]) => {
      if (Array.isArray(docs) && docs[0]?.action === 'money_minor_mismatch') return Promise.reject(new Error('audit down'));
      return (original as any)(docs, ...rest);
    }) as any);
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    expect(res.success).toBe(true);
  });
});

describe('old payloads and new payloads side by side (server contract)', () => {
  it('an OLD payload (decimals only, no minor keys) sells exactly as before and still gets minor stored', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10, taxRate: 0.05 });
    const sid = await openSession(svc, s);
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid, { clientTotal: 21, amountTendered: 30 }) as any, undefined);
    const doc = await rawSale(res.data._id);
    expect([doc.total, num(doc.totalMinor)]).toEqual([21, 2100]);
  });

  it('a NEW payload (decimals + minor twins) is accepted when they agree, and the server recomputes regardless', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10, taxRate: 0.05 });
    const sid = await openSession(svc, s);
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid, {
      clientTotal: 21, clientTotalMinor: 2100, amountTendered: 30, amountTenderedMinor: 3000,
      items: [{ productId: s.productId, variantId: s.variantId, qty: 2, unitPriceMinor: 1000 }],
      payments: [{ method: 'cash', amount: 30, amountMinor: 3000 }],
    }) as any, undefined);
    expect(num((await rawSale(res.data._id)).totalMinor)).toBe(2100);
  });

  it('a LIVE sale whose decimal and minor DISAGREE is ACCEPTED at the server\'s own values, and the mismatch is recorded with both values', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid, {
      clientTotal: 20, clientTotalMinor: 2100,                       // the client's own twin is off by 1.00
      amountTendered: 20, amountTenderedMinor: 25,
      payments: [{ method: 'cash', amount: 20, amountMinor: 1999 }],
      items: [{ productId: s.productId, variantId: s.variantId, qty: 2, unitPrice: 10, unitPriceMinor: 999 }],
    }) as any, undefined);
    expect(res.success).toBe(true);                                  // NEVER rejected
    const doc = await rawSale(res.data._id);
    expect([doc.status, doc.total, num(doc.totalMinor), num(doc.items[0].priceMinor), num(doc.payments[0].amountMinor)]).toEqual(['completed', 20, 2000, 1000, 2000]); // the server's values
    expect(mismatches(doc, 'sale')).toEqual([]);                      // what is STORED is self-consistent
    expect(await h.repos.saleModel.countDocuments({ storeId: s.storeId })).toBe(1);
    expect(((await h.repos.productVariantModel.collection.findOne({ _id: new Types.ObjectId(s.variantId) })) as any).stock).toBe(18); // stock taken exactly once
    const [ev]: any[] = await h.repos.posAuditLogModel.find({ storeId: s.storeId, action: 'money_minor_mismatch' }).lean();
    expect(ev).toMatchObject({ targetType: 'sale', targetId: String(res.data._id) });
    expect(ev.metadata).toMatchObject({ source: 'client', offline: false, serverTotalMinor: 2000, count: 4 });
    const byField = Object.fromEntries(ev.metadata.mismatches.map((m: any) => [m.field, m]));
    expect(byField['clientTotal']).toMatchObject({ clientDecimal: 20, clientMinor: 2100, serverMinor: 2000, reason: 'decimal_and_minor_disagree' });
    expect(byField['amountTendered']).toMatchObject({ clientDecimal: 20, clientMinor: 25 });
    expect(byField['payments[0].amount']).toMatchObject({ clientMinor: 1999 });
    expect(byField['items[0].unitPrice']).toMatchObject({ clientMinor: 999 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('[pos-minor-mismatch] client payload'))).toBe(true);
    expect(PosMinorMetrics.snapshot().clientPayloadMismatches).toBe(4);
    expect(PosMinorMetrics.snapshot().totalMismatchedDocs).toBe(0);  // not a storage inconsistency
  });

  it('a malformed twin (a fraction, a string, NaN) never rejects a sale either — it is recorded', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [i, bad] of ([5.5, '12', NaN, 2 ** 60] as any[]).entries()) {
      const res: any = await svc.createSale(s.sellerId, saleDto(s, sid, { clientTotal: 20, clientTotalMinor: bad, idempotencyKey: `bad-${i}` }) as any, undefined);
      expect(res.success).toBe(true);
      expect(num((await rawSale(res.data._id)).totalMinor)).toBe(2000);
    }
    const evs: any[] = await h.repos.posAuditLogModel.find({ storeId: s.storeId, action: 'money_minor_mismatch' }).lean();
    expect(evs).toHaveLength(4);
    expect(evs.every((e) => e.metadata.mismatches[0].reason === 'minor_not_a_safe_integer')).toBe(true);
  });

  it('a held sale COMPLETED with a disagreeing twin is accepted at the server\'s values and recorded', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const held: any = await svc.createSale(s.sellerId, saleDto(s, sid, { status: 'held' }) as any, undefined);
    const done: any = await svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'cash', amountTendered: 20, amountTenderedMinor: 2500, clientTotal: 20, clientTotalMinor: 2000 } as any, undefined);
    expect(done.success).toBe(true);
    expect(num((await rawSale(done.data._id)).totalMinor)).toBe(2000);
    expect(await h.repos.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'money_minor_mismatch' })).toBe(1);
  });

  it('an OLD offline payload (queued by an older build: decimals only, unitPrice, old shape) still syncs; a NEW offline payload with minor twins syncs too — even with an injected client mismatch', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { openedAt: new Date(Date.now() - 5 * 3600_000) } }); // the shift was already open when the offline sale was made
    const madeAt = new Date(Date.now() - 3600_000).toISOString();
    const oldQueued = { ...saleDto(s, sid), offline: true, clientCreatedAt: madeAt, idempotencyKey: 'old-1', clientTotal: 20, amountTendered: 20, items: [{ productId: s.productId, variantId: s.variantId, qty: 2, unitPrice: 10 }] };
    const newQueued = { ...saleDto(s, sid), offline: true, clientCreatedAt: madeAt, idempotencyKey: 'new-1', clientTotal: 20, clientTotalMinor: 2000, amountTendered: 20, amountTenderedMinor: 2000, items: [{ productId: s.productId, variantId: s.variantId, qty: 2, unitPrice: 10, unitPriceMinor: 1000 }] };
    const a: any = await svc.createSale(s.sellerId, oldQueued as any, undefined);
    const b: any = await svc.createSale(s.sellerId, newQueued as any, undefined);
    for (const r of [a, b]) {
      const doc = await rawSale(r.data._id);
      expect([doc.isOffline, doc.total, num(doc.totalMinor), num(doc.items[0].priceMinor)]).toEqual([true, 20, 2000, 1000]);
      expect(mismatches(doc, 'sale')).toEqual([]);
    }
    // …and a queued NEW payload carrying a disagreeing twin STILL SYNCS — the cash was already taken, so it is never rejected: stored at the server's values, recorded with source=client, offline=true
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const c: any = await svc.createSale(s.sellerId, { ...newQueued, idempotencyKey: 'new-2', clientTotalMinor: 2001, items: [{ productId: s.productId, variantId: s.variantId, qty: 2, unitPrice: 10, unitPriceMinor: 1001 }] } as any, undefined);
    expect(c.success).toBe(true);
    const cdoc = await rawSale(c.data._id);
    expect([cdoc.isOffline, cdoc.total, num(cdoc.totalMinor), num(cdoc.items[0].priceMinor)]).toEqual([true, 20, 2000, 1000]);
    const [ev]: any[] = await h.repos.posAuditLogModel.find({ storeId: s.storeId, action: 'money_minor_mismatch', targetId: String(c.data._id) }).lean();
    expect(ev.metadata).toMatchObject({ source: 'client', offline: true, serverTotalMinor: 2000, count: 2 });
    expect(ev.metadata.mismatches.map((m: any) => m.field).sort()).toEqual(['clientTotal', 'items[0].unitPrice']);
  });

  it('quote and reports expose the minor twins next to the decimals', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10, taxRate: 0.05 });
    const sid = await openSession(svc, s);
    await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    const q: any = await svc.quoteSale(s.sellerId, { storeId: s.storeId, items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] } as any);
    expect([q.data.total, q.data.totalMinor, q.data.subtotalMinor, q.data.taxMinor, q.data.lines[0].lineTotalMinor]).toEqual([21, 2100, 2000, 100, 2000]);
    const rep: any = await svc.getSessionReport(s.sellerId, sid);
    expect([rep.data.summary.totalSalesMinor, rep.data.summary.cashFlow.openingCashMinor, rep.data.summary.cashFlow.cashSalesMinor]).toEqual([2100, 10000, 2100]);
    const day: any = await svc.getDailyReport(s.sellerId, s.storeId, {});
    expect([day.data.summary.totalRevenueMinor, day.data.summary.netRevenueMinor, day.data.summary.avgTransactionValueMinor]).toEqual([2100, 2100, 2100]);
  });
});
