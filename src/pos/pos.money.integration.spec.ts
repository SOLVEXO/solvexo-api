/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { MongoHarness, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/**
 * Phase 5B against a REAL MongoDB: server-authoritative totals, exponent-based rounding (JPY / PKR / KWD / USD),
 * tampered client totals, split tender, refunds allocated across tenders, and the session cash that results.
 */
jest.setTimeout(120_000);

let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const token = (s: Seed, role: 'manager' | 'cashier' = 'manager') =>
  jwt.sign({ employeeId: role === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });

async function open(svc: PosService, s: Seed, openingCash = 0) {
  const res: any = await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash } as any);
  return String(res.data._id);
}
const dto = (s: Seed, sessionId: string, over: any = {}) => ({
  storeId: s.storeId, sessionId, registerId: s.registerId, employeeId: s.cashierId,
  items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: 'cash', ...over,
});
const session = async (id: string): Promise<any> => h.repos.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(id) });
const rawSale = async (id: string): Promise<any> => h.repos.saleModel.collection.findOne({ _id: new Types.ObjectId(id) });
const code = async (p: Promise<any>) => { try { await p; return 'NO_ERROR'; } catch (e: any) { return e.getResponse?.().code ?? e.message; } };

describe('server-authoritative totals, rounded to the store currency\'s exponent', () => {
  it('USD store: stores currency + exponent, rounds each step, applies the store tax rate to (subtotal − discount)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 50, price: 19.99, taxRate: 0.0825 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }], discountType: 'percent', discountValue: 10, paymentMethod: 'card' }) as any, token(s));
    // 59.97 → 10% = 5.997 → 6.00; taxable 53.97; tax 4.452525 → 4.45; total 58.42
    expect(res.data).toMatchObject({ currency: 'USD', currencyExponent: 2, subtotal: 59.97, discount: 6, tax: 4.45, total: 58.42, taxRate: 0.0825, discountType: 'percent', discountValue: 10 });
  });

  it('JPY store: whole yen everywhere — no fractional amounts stored', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 50, price: 333, baseCurrency: 'JPY', taxRate: 0.1 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }], discountType: 'percent', discountValue: 15 }) as any, token(s));
    // 999 − 15% (149.85 → 150) = 849; tax 84.9 → 85; total 934
    expect(res.data).toMatchObject({ currency: 'JPY', currencyExponent: 0, subtotal: 999, discount: 150, tax: 85, total: 934 });
    for (const v of [res.data.subtotal, res.data.discount, res.data.tax, res.data.total]) expect(Number.isInteger(v)).toBe(true);
    expect((await session(sid)).currencyExponent).toBe(0);
  });

  it('KWD store: three decimals survive', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 50, price: 1.255, baseCurrency: 'KWD', taxRate: 0.05 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }], discountType: 'amount', discountValue: 0.5 }) as any, token(s));
    expect(res.data).toMatchObject({ currency: 'KWD', currencyExponent: 3, subtotal: 3.765, discount: 0.5, tax: 0.163, total: 3.428 });
  });

  it('PKR store: 2 decimals, flat discount', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 50, price: 1499.5, baseCurrency: 'PKR' });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], discount: 99.99 }) as any, token(s));
    expect(res.data).toMatchObject({ currency: 'PKR', currencyExponent: 2, subtotal: 2999, discount: 99.99, total: 2899.01 });
  });

  it('a client-sent `tax` is IGNORED — the server uses the store rate', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 50, price: 10, taxRate: 0.1 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, { tax: 0 }) as any, undefined);
    expect(res.data.tax).toBe(1);
    expect(res.data.total).toBe(11);
    const noRate = await seedStore(h, { stock: 50, price: 10 });
    const sid2 = await open(svc, noRate);
    const res2: any = await svc.createSale(noRate.sellerId, dto(noRate, sid2, { tax: 500 }) as any, undefined);
    expect(res2.data.tax).toBe(0); // inflating tax from the client does nothing
  });

  it('a TAMPERED client total is rejected with the server figures — no sale, no stock taken', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10, taxRate: 0.1 });
    const sid = await open(svc, s);
    try { await svc.createSale(s.sellerId, dto(s, sid, { clientTotal: 1 }) as any, undefined); throw new Error('should reject'); } catch (e: any) {
      expect(e.getResponse()).toMatchObject({ code: 'TOTAL_MISMATCH', expectedTotal: 11, clientTotal: 1, tax: 1 });
    }
    expect(await h.repos.saleModel.countDocuments({})).toBe(0);
    expect(await stockOf(h, s.variantId)).toBe(10);
    // ±1 minor unit is accepted, the SERVER total is what gets stored
    const ok: any = await svc.createSale(s.sellerId, dto(s, sid, { clientTotal: 11.01 }) as any, undefined);
    expect(ok.data.total).toBe(11);
  });

  it('rejects a discount over the subtotal and one a cashier is not allowed to give', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s);
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { discount: 10.01 }) as any, token(s)))).toBe('DISCOUNT_EXCEEDS_SUBTOTAL');
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { discountType: 'percent', discountValue: 20 }) as any, token(s, 'cashier')))).toBe('Only managers can apply a discount');
    expect(await stockOf(h, s.variantId)).toBe(10);
  });
});

describe('split tender', () => {
  it('card + cash (with change): payment lines, change computed and stored, session counters per tender', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s, 100);
    const res: any = await svc.createSale(s.sellerId, dto(s, sid, {
      items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }],
      payments: [{ method: 'card', amount: 60, reference: 'AUTH-77' }, { method: 'cash', amount: 50 }],
    }) as any, undefined);

    expect(res.data.total).toBe(100);
    expect(res.data.paymentMethod).toBe('split');
    expect(res.data.changeGiven).toBe(10);
    expect(res.data.payments.map((p: any) => [p.method, p.amount, p.tendered ?? null, p.reference ?? null])).toEqual([
      ['card', 60, null, 'AUTH-77'], ['cash', 40, 50, null],
    ]);
    const sess = await session(sid);
    expect(sess).toMatchObject({ totalSales: 100, cashSales: 40, cardSales: 60, totalTransactions: 1 });
  });

  it('rejects short payments, card over the total, and unknown methods — and takes no stock', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s);
    const two = { items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] };
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { ...two, payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 30 }] }) as any, undefined))).toBe('PAYMENT_SHORT');
    expect(await code(svc.createSale(s.sellerId, dto(s, sid, { ...two, payments: [{ method: 'card', amount: 120 }] }) as any, undefined))).toBe('PAYMENT_EXCEEDS_TOTAL');
    expect(await stockOf(h, s.variantId)).toBe(10);
    expect(await h.repos.saleModel.countDocuments({})).toBe(0);
  });

  it('single cash payment with tendered > total stores the change; single card stores its reference', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 12.5 });
    const sid = await open(svc, s);
    const a: any = await svc.createSale(s.sellerId, dto(s, sid, { amountTendered: 20 }) as any, undefined);
    expect(a.data).toMatchObject({ paymentMethod: 'cash', changeGiven: 7.5 });
    expect(a.data.payments[0]).toMatchObject({ method: 'cash', amount: 12.5, tendered: 20 });
    const b: any = await svc.createSale(s.sellerId, dto(s, sid, { paymentMethod: 'card', paymentReference: 'ref-9' }) as any, undefined);
    expect(b.data.payments[0]).toMatchObject({ method: 'card', amount: 12.5, reference: 'ref-9' });
  });

  it('held sale → completed with split tender, re-priced with the current tax rate', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50, taxRate: 0.1 });
    const sid = await open(svc, s);
    const held: any = await svc.createSale(s.sellerId, dto(s, sid, { status: 'held' }) as any, undefined);
    expect(held.data.payments).toEqual([]);
    const done: any = await svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'cash', payments: [{ method: 'card', amount: 25 }, { method: 'cash', amount: 30 }], clientTotal: 55 } as any, undefined);
    expect(done.data).toMatchObject({ total: 55, paymentMethod: 'split', changeGiven: 0 });
    expect((await session(sid))).toMatchObject({ cashSales: 30, cardSales: 25, totalSales: 55 });
  });
});

describe('refunds against split tender (card/other first, cash last)', () => {
  it('partial refunds come off the CARD first; the drawer\'s cash is untouched until the card is exhausted', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s, 0);
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, {
      items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }],
      payments: [{ method: 'cash', amount: 40 }, { method: 'card', amount: 60 }], // cash entered FIRST, still refunded LAST
    }) as any, undefined);
    const id = String(sale.data._id);
    const item = String(sale.data.items[0]._id);

    const r1: any = await svc.refundSale(s.sellerId, id, { items: [{ saleItemId: item, qty: 1 }] } as any, token(s));
    expect(r1.data).toMatchObject({ refundedAmount: 50, newStatus: 'partially_refunded' });
    expect(r1.data.tenders).toEqual([{ method: 'card', amount: 50 }]);
    expect(await session(sid)).toMatchObject({ cashSales: 40, cardSales: 10, totalSales: 50, totalRefunds: 50, totalTransactions: 1 });

    const r2: any = await svc.refundSale(s.sellerId, id, { items: [{ saleItemId: item, qty: 1 }] } as any, token(s));
    expect(r2.data).toMatchObject({ refundedAmount: 50, newStatus: 'refunded' });
    expect(r2.data.tenders).toEqual(expect.arrayContaining([{ method: 'card', amount: 10 }, { method: 'cash', amount: 40 }]));
    expect(await session(sid)).toMatchObject({ cashSales: 0, cardSales: 0, totalSales: 0, totalRefunds: 100, totalTransactions: 0 });

    const stored = await rawSale(id);
    expect(stored.refunds).toHaveLength(2);
    expect(stored.refunds[0]).toMatchObject({ amount: 50, kind: 'partial', currency: 'USD', currencyExponent: 2 });
    expect(stored.refundedAmount).toBe(100);
    expect(await stockOf(h, s.variantId)).toBe(10);
  });

  it('a FULL refund of a split sale returns each tender what it took (cash change is not refunded)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s);
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, {
      items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }],
      payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 50 }], // 10 change
    }) as any, undefined);
    const r: any = await svc.refundSale(s.sellerId, String(sale.data._id), undefined, token(s));
    expect(r.data.refundedAmount).toBe(100);
    expect(r.data.tenders).toEqual(expect.arrayContaining([{ method: 'card', amount: 60 }, { method: 'cash', amount: 40 }]));
    expect(await session(sid)).toMatchObject({ cashSales: 0, cardSales: 0, totalSales: 0, totalTransactions: 0 });
  });

  it('void reverses every tender exactly', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s);
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, {
      items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }],
      payments: [{ method: 'card', amount: 60 }, { method: 'cash', amount: 50 }],
    }) as any, undefined);
    await svc.voidSale(s.sellerId, String(sale.data._id), {}, token(s));
    expect(await session(sid)).toMatchObject({ cashSales: 0, cardSales: 0, totalSales: 0, totalTransactions: 0 });
  });

  it('pro-rates discount AND tax: refunding one of three units returns a third of what was PAID; the last refund is the exact remainder', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10, taxRate: 0.08 });
    const sid = await open(svc, s);
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, {
      items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }], discountType: 'percent', discountValue: 10, paymentMethod: 'card',
    }) as any, token(s));
    expect(sale.data.total).toBe(29.16); // 30 − 3 + 2.16
    const id = String(sale.data._id); const item = String(sale.data.items[0]._id);
    const a: any = await svc.refundSale(s.sellerId, id, { items: [{ saleItemId: item, qty: 1 }] } as any, token(s));
    expect(a.data.refundedAmount).toBe(9.72);
    const b: any = await svc.refundSale(s.sellerId, id, { items: [{ saleItemId: item, qty: 2 }] } as any, token(s));
    expect(b.data.refundedAmount).toBe(19.44);
    expect((await rawSale(id)).refundedAmount).toBe(29.16);
  });

  it('JPY: partial refunds stay whole yen', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 500, baseCurrency: 'JPY', taxRate: 0.1 });
    const sid = await open(svc, s);
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] }) as any, undefined);
    expect(sale.data.total).toBe(1650);
    const r: any = await svc.refundSale(s.sellerId, String(sale.data._id), { items: [{ saleItemId: String(sale.data.items[0]._id), qty: 1 }] } as any, token(s));
    expect(r.data.refundedAmount).toBe(550);
    expect(Number.isInteger(r.data.refundedAmount)).toBe(true);
  });
});

describe('expected cash after a partial CASH refund (the drawer reconciles)', () => {
  it('a cash partial refund lowers expected cash; closing with exactly that count has zero variance', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s, 100);
    const sale: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] }) as any, undefined);
    expect((await session(sid)).cashSales).toBe(100);

    await svc.refundSale(s.sellerId, String(sale.data._id), { items: [{ saleItemId: String(sale.data.items[0]._id), qty: 1 }] } as any, token(s));
    expect((await session(sid)).cashSales).toBe(50); // the drawer paid 50 back

    const report: any = await svc.getSessionReport(s.sellerId, sid);
    expect(report.data.summary.byPaymentMethod.cash).toEqual({ count: 1, total: 50 }); // partially refunded sale is still counted, net of the refund
    expect(report.data.summary.refundsTotal).toBe(50);

    const closed: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 150 } as any);
    expect(closed.data).toMatchObject({ expectedCash: 150, cashDifference: 0, closingCash: 150, currency: 'USD' });
  });

  it('cash-in / cash-out amounts and the close are rounded to the currency exponent (JPY)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 500, baseCurrency: 'JPY' });
    const sid = await open(svc, s, 1000.4);
    expect((await session(sid)).openingCash).toBe(1000);
    await svc.cashInOut(s.sellerId, sid, { type: 'cash_in', amount: 250.6, reason: 'float', employeeId: s.managerId } as any, token(s));
    const closed: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 1251 } as any);
    expect(closed.data).toMatchObject({ expectedCash: 1251, cashDifference: 0 });
  });
});

describe('reports show the right currency, decimals and partial refunds', () => {
  it('daily report: currency + exponent, partially-refunded sales included, tender figures net of refunds, netRevenue = revenue − partial refunds', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 20, price: 50 });
    const sid = await open(svc, s);
    const a: any = await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] }) as any, undefined); // cash 100
    await svc.createSale(s.sellerId, dto(s, sid, { paymentMethod: 'card' }) as any, undefined);                                                                  // card 50
    await svc.refundSale(s.sellerId, String(a.data._id), { items: [{ saleItemId: String(a.data.items[0]._id), qty: 1 }] } as any, token(s));                   // cash −50

    const r: any = await svc.getDailyReport(s.sellerId, s.storeId, {});
    expect(r.data).toMatchObject({ currency: 'USD', currencyExponent: 2 });
    expect(r.data.summary).toMatchObject({ totalTransactions: 2, totalRevenue: 150, netRevenue: 100, refundsCount: 1, refundsTotal: 50 });
    expect(r.data.byPaymentMethod.cash).toEqual({ count: 1, total: 50 });
    expect(r.data.byPaymentMethod.card).toEqual({ count: 1, total: 50 });
  });

  it('range report mirrors it (JPY: integers)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 20, price: 333, baseCurrency: 'JPY', taxRate: 0.1 });
    const sid = await open(svc, s);
    await svc.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] }) as any, undefined);
    const today = new Date().toISOString().split('T')[0];
    const r: any = await svc.getDateRangeReport(s.sellerId, s.storeId, { from: today, to: today });
    expect(r.data).toMatchObject({ currency: 'JPY', currencyExponent: 0 });
    expect(Number.isInteger(r.data.summary.totalRevenue)).toBe(true);
    expect(r.data.summary.totalRevenue).toBe(1099); // 999 + 100 (99.9 → 100)
  });

  it('CSV writes exactly the currency\'s decimals and describes split payments', async () => {
    const svc = makeService();
    const jpy = await seedStore(h, { stock: 20, price: 333, baseCurrency: 'JPY' });
    const sid = await open(svc, jpy);
    await svc.createSale(jpy.sellerId, dto(jpy, sid, { payments: [{ method: 'card', amount: 100 }, { method: 'cash', amount: 300 }] }) as any, undefined);
    const csv = await svc.exportDailyReportCsv(jpy.sellerId, jpy.storeId, {});
    const row = csv.split('\n')[1];
    expect(row).toContain('JPY');
    expect(row).toContain('333');
    expect(row).not.toMatch(/333\.\d/);           // no fractional yen
    expect(row).toContain('card 100 + cash 233');
  });

  it('getPosSettings reports the store currency and exponent; getSaleById / getSales backfill them for old sales', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 5, price: 1, baseCurrency: 'KWD' });
    const settings: any = await svc.getPosSettings(s.sellerId, s.storeId);
    expect(settings.data).toMatchObject({ currency: 'KWD', currencyExponent: 3 });
    const legacyId = new Types.ObjectId();
    await h.repos.saleModel.collection.insertOne({ _id: legacyId, saleNumber: 'POS-LEG', storeId: s.storeId, sessionId: 'x', registerId: 'r', employeeId: 'e', items: [], subtotal: 5, discount: 0, tax: 0, total: 5, paymentMethod: 'cash', status: 'completed', createdAt: new Date() });
    const one: any = await svc.getSaleById(s.sellerId, String(legacyId));
    expect(one.data).toMatchObject({ currency: 'KWD', currencyExponent: 3, total: 5 });
    const list: any = await svc.getSales(s.sellerId, { storeId: s.storeId });
    expect(list.data.sales[0]).toMatchObject({ currency: 'KWD', currencyExponent: 3 });
  });
});

describe('sales made BEFORE split tender / currency snapshots stay readable and refundable', () => {
  it('a legacy cash sale (no payments array, no currency) refunds correctly against its single tender', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 50 });
    const sid = await open(svc, s, 0);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { cashSales: 100, totalSales: 100, totalTransactions: 1 }, $unset: { currency: '', currencyExponent: '' } });
    const legacyId = new Types.ObjectId();
    const itemId = new Types.ObjectId();
    await h.repos.saleModel.collection.insertOne({
      _id: legacyId, saleNumber: 'POS-LEG', storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId,
      items: [{ _id: itemId, productId: s.productId, variantId: s.variantId, name: 'Tea', sku: 'TEA-1', price: 50, qty: 2, lineTotal: 100, refundedQty: 0 }],
      subtotal: 100, discount: 0, tax: 0, total: 100, paymentMethod: 'cash', status: 'completed', refundedAmount: 0, createdAt: new Date(),
    });
    const r: any = await svc.refundSale(s.sellerId, String(legacyId), { items: [{ saleItemId: String(itemId), qty: 1 }] } as any, token(s));
    expect(r.data).toMatchObject({ refundedAmount: 50, currency: 'USD', currencyExponent: 2 });
    expect(r.data.tenders).toEqual([{ method: 'cash', amount: 50 }]);
    expect(await session(sid)).toMatchObject({ cashSales: 50, totalSales: 50 });
    const report: any = await svc.getSessionReport(s.sellerId, sid);
    expect(report.data.summary.byPaymentMethod.cash.total).toBe(50);
  });
});
