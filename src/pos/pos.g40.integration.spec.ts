/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosReportsService } from './pos-reports.service';
import { PosCashService } from './pos-cash.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { moneyContractViolations } from './testing/money-contract';

/** G4.0 / G4.1 on a real replica-set MongoDB: the store time zone, the business pulse and the eight reports — live from the ledgers. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let rep: PosReportsService; let cash: PosCashService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, {
    posExpenseModel: h.conn.model(schema.PosExpense.name, schema.PosExpenseSchema), posExpenseEventModel: h.conn.model(schema.PosExpenseEvent.name, schema.PosExpenseEventSchema),
    supplierLedgerEntryModel: h.conn.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
    posAttendanceEventModel: h.conn.model(schema.PosAttendanceEvent.name, schema.PosAttendanceEventSchema), posAttendanceStateModel: h.conn.model(schema.PosAttendanceState.name, schema.PosAttendanceStateSchema),
  });
  r = h.repos;
  await Promise.all(['posExpenseModel', 'posExpenseEventModel', 'supplierLedgerEntryModel', 'posAttendanceEventModel', 'posAttendanceStateModel', 'posSettingsModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, svc);
  rep = new PosReportsService(dbs, svc, auth);
  cash = new PosCashService(dbs, svc, auth, {} as any);
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

/** a PK store (no explicit zone → Asia/Karachi), 10.00 + 10 % tax, one variant whose cost we set before each sale */
async function world(opts: { currency?: string; country?: string } = {}) {
  const s = await seedStore(h, { stock: 10_000, price: 10, baseCurrency: opts.currency ?? 'PKR', taxRate: 0.1 });
  await r.storeModel.collection.updateOne({ _id: new Types.ObjectId(s.storeId) }, { $set: { country: opts.country ?? 'PK' } });
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 86_400_000 * 30), openingCash: 100, totalSales: 0, totalTransactions: 0 });
  const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
  const cost = (minor: number | null) => r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: minor === null ? { costPrice: null, costPriceMinor: null } : { costPrice: minor / 100, costPriceMinor: minor } });
  /** sell `qty` at `at` (moved there after the sale), as the cashier unless told otherwise */
  const sell = async (qty: number, at: Date, over: any = {}, who: 'cashier' | 'manager' = 'cashier') => {
    const sale: any = ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: who === 'cashier' ? s.cashierId : s.managerId, items: [{ productId: s.productId, variantId: s.variantId, qty }], paymentMethod: 'cash', ...over } as any, tok(s, 'manager'))) as any).data;
    await r.saleModel.collection.updateOne({ _id: new Types.ObjectId(String(sale._id)) }, { $set: { createdAt: at } });
    return sale;
  };
  const q = (from: string, to = from, extra: any = {}) => ({ from, to, ...extra });
  return { s, sid, M, C, cost, sell, q };
}
const pk = (day: string, hh: number, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:00`); // a wall-clock time in Karachi

describe('store time zone (G4.0)', () => {
  it('a PK store without a setting runs in Asia/Karachi; the owner sets another zone (audited); a manager cannot; junk is refused', async () => {
    const w = await world();
    expect((await rep.timeZone(device(w.s), w.s.storeId)).data).toMatchObject({ timeZone: 'Asia/Karachi', explicit: false });
    expect(await code(rep.setTimeZone(device(w.s), w.s.storeId, { timeZone: 'Europe/London' }, w.M))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(rep.setTimeZone(owner(w.s), w.s.storeId, { timeZone: 'Mars/Olympus' }, {}))).toBe('INVALID_TIME_ZONE');
    expect((await rep.setTimeZone(owner(w.s), w.s.storeId, { timeZone: 'Europe/London' }, {})).data).toMatchObject({ timeZone: 'Europe/London', explicit: true });
    const audit: any = await r.posAuditLogModel.findOne({ storeId: w.s.storeId, action: 'store_time_zone_changed' }).lean();
    expect(audit.metadata).toEqual({ before: 'Asia/Karachi', after: 'Europe/London' });
  });

  it('a sale at 23:30 Karachi time belongs to THAT day in every report (UTC would say the same day; 00:30 the next) — and the daily report, the dashboard day, the daybook day follow the zone', async () => {
    const w = await world();
    await w.cost(400);
    await w.sell(1, pk('2026-11-03', 23, 30));
    await w.sell(2, pk('2026-11-04', 0, 30)); // 19:30 UTC on the 3rd — a UTC day would put it on the 3rd
    const d3 = (await rep.sales(device(w.s), w.s.storeId, w.q('2026-11-03'), w.M)).data;
    const d4 = (await rep.sales(device(w.s), w.s.storeId, w.q('2026-11-04'), w.M)).data;
    expect([d3.totals.transactions, d4.totals.transactions, d3.timeZone]).toEqual([1, 1, 'Asia/Karachi']);
    const hourly = (await rep.hourly(device(w.s), w.s.storeId, w.q('2026-11-03', '2026-11-04'), w.M)).data;
    expect([hourly.byHour[23].transactions, hourly.byHour[0].transactions]).toEqual([1, 1]);
    const daily: any = (await svc.getDailyReport(w.s.sellerId, w.s.storeId, { date: '2026-11-04' })).data;
    expect([daily.date, daily.timeZone, daily.summary?.totalTransactions ?? daily.totalTransactions ?? daily.summary?.transactions]).toEqual(['2026-11-04', 'Asia/Karachi', 1]);
  });
});

describe('the reports (G4.1)', () => {
  /** three days of trading with known costs, one line without a cost, a partial return, a void, expenses and a supplier payment */
  async function trade() {
    const w = await world();
    await w.cost(400);                                   // 4.00 cost, 10.00 price
    await w.sell(3, pk('2026-11-02', 10));                // net 30.00, cost 12.00
    const card = await w.sell(2, pk('2026-11-02', 15), { paymentMethod: 'card' }); // net 20.00, cost 8.00
    await w.cost(600);
    const ret = await w.sell(4, pk('2026-11-03', 11), {}, 'manager'); // net 40.00, cost 24.00
    await w.cost(null);
    await w.sell(1, pk('2026-11-03', 12));                // net 10.00, cost UNKNOWN
    await w.cost(400);
    const gone = await w.sell(5, pk('2026-11-04', 9));    // voided → never happened
    await svc.voidSale(w.s.sellerId, String(gone._id), { reason: 'mistake' }, tok(w.s, 'manager'));
    // a return of 1 unit of the manager's sale, on the 4th (credit note in the period, cost back at the SALE's 6.00)
    await svc.refundSale(w.s.sellerId, String(ret._id), { items: [{ saleItemId: String(ret.items[0]._id), qty: 1 }] } as any, tok(w.s, 'manager'));
    await r.posCreditNoteModel.collection.updateMany({ storeId: w.s.storeId, kind: 'return' }, { $set: { createdAt: pk('2026-11-04', 10) } });
    await r.posRefundModel.collection.updateMany({ storeId: w.s.storeId }, { $set: { createdAt: pk('2026-11-04', 10) } });
    await r.posCreditNoteModel.collection.updateMany({ storeId: w.s.storeId, kind: 'void' }, { $set: { createdAt: pk('2026-11-04', 9, 5) } });
    // expenses (one rejected) and a supplier payment — the payment must never reduce profit
    const ex = (amountMinor: number, category: string) => r.posExpenseModel.create({ storeId: w.s.storeId, number: `EXP-${amountMinor}`, seq: amountMinor, category, amountMinor, currency: 'PKR', currencyExponent: 2, method: 'bank', occurredAt: pk('2026-11-03', 18), requestId: `x${amountMinor}` });
    await ex(500, 'utilities'); const rej = await ex(700, 'meals');
    await r.posExpenseEventModel.create({ storeId: w.s.storeId, expenseId: String(rej._id), type: 'rejected', note: 'no' });
    await r.supplierLedgerEntryModel.create({ storeId: w.s.storeId, supplierId: 'sup1', type: 'payment', amountMinor: -50_000, currency: 'PKR', currencyExponent: 2, dedupeKey: 'p1', createdAt: pk('2026-11-03', 9) });
    return { w, card };
  }

  it('sales: transactions, gross, net after returns, tax, by local day; previous-period comparison', async () => {
    const { w } = await trade();
    const d = (await rep.sales(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04', { compare: 'previous' }), w.M)).data;
    expect(d.totals.transactions).toBe(4); // the voided sale never happened
    expect(d.totals.grossSalesMinor).toBe(11_000); // 100.00 net + 10 % tax
    expect(d.totals.returns).toBe(1);
    expect(d.totals.netSalesMinor).toBe(10_000 - 1_000); // net ex tax minus the returned unit
    expect(d.byDay.map((x: any) => [x.day, x.transactions])).toEqual([['2026-11-02', 2], ['2026-11-03', 2], ['2026-11-04', 0]]);
    expect(d.previous!.period).toEqual({ from: '2026-10-30', to: '2026-11-01' });
    expect(d.previous!.totals.transactions).toBe(0);
    expect(d.previous!.byDay.map((x: any) => x.day)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']); // the dashed line needs no second request
    const day3: any = (await svc.getSales(w.s.sellerId, { storeId: w.s.storeId, date: '2026-11-03' })).data;
    expect(day3.sales.length).toBe(2); // a day bar drills into the Orders list by store day
  });

  it('profit: gross margin over lines WITH a cost (coverage shown), returns at the sale\'s cost, after expenses (rejected excluded) — supplier payments NEVER subtracted', async () => {
    const { w } = await trade();
    const p = (await rep.profit(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data.totals;
    // known-cost net: 30 + 20 + 40 − 10 (returned) = 80.00; cost: 12 + 8 + 24 − 6 = 38.00 → margin 42.00; unknown-cost net 10.00
    expect([p.netSalesMinor, p.costOfGoodsSoldMinor, p.grossMarginMinor, p.costUnknownNetMinor]).toEqual([9_000, 3_800, 4_200, 1_000]);
    expect(p.costCoveragePercent).toBe(88.9);
    expect(p.marginPercent).toBe(52.5);
    expect([p.expensesMinor, p.afterExpensesMinor]).toEqual([500, 3_700]);
    expect(p.supplierPaymentsMinor).toBe(50_000); // shown for information …
    // … and adding another supplier payment changes NOTHING in the profit
    await r.supplierLedgerEntryModel.create({ storeId: w.s.storeId, supplierId: 'sup1', type: 'payment', amountMinor: -99_999, currency: 'PKR', currencyExponent: 2, dedupeKey: 'p2', createdAt: pk('2026-11-03', 9) });
    const p2 = (await rep.profit(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data.totals;
    expect([p2.grossMarginMinor, p2.afterExpensesMinor, p2.supplierPaymentsMinor]).toEqual([4_200, 3_700, 149_999]);
  });

  it('products and categories add up to the sales totals; tax = Σ invoice tax − Σ credit-note tax', async () => {
    const { w } = await trade();
    const prod = (await rep.products(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data;
    expect(prod.products).toHaveLength(1);
    expect(prod.products[0]).toMatchObject({ qtySold: 10, qtyReturned: 1, netSalesMinor: 9_000, sku: 'TEA-1' });
    const cat = (await rep.categories(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data;
    expect(cat.categories.reduce((n: number, x: any) => n + x.netSalesMinor, 0)).toBe(9_000);
    const tax = (await rep.tax(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data;
    expect(tax.totals.netTaxMinor).toBe(tax.totals.invoiceTaxMinor - tax.totals.creditNoteTaxMinor);
    expect([tax.totals.invoiceTaxMinor, tax.totals.creditNoteTaxMinor, tax.totals.netTaxMinor]).toEqual([1_000, 100, 900]);
  });

  it('payment mix: per tender, refunds out of the tender that paid them; cashier report: a cashier sees only themself, hours come from attendance', async () => {
    const { w } = await trade();
    const pay = (await rep.payments(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data;
    const byM = Object.fromEntries(pay.methods.map((m: any) => [m.method, m]));
    expect([byM.cash.paidMinor, byM.cash.refundedMinor, byM.card.paidMinor]).toEqual([8_800, 1_100, 2_200]);
    // attendance: the cashier worked 8 h on the 3rd
    const ev = (type: string, at: Date) => r.posAttendanceEventModel.collection.insertOne({ storeId: w.s.storeId, employeeId: w.s.cashierId, type, recordId: 'rc1', deviceAt: at, serverAt: at, at, flags: [] });
    await ev('clock_in', pk('2026-11-03', 9)); await ev('clock_out', pk('2026-11-03', 17));
    const mine = (await rep.cashiers(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.C)).data;
    expect(mine.ownOnly).toBe(true);
    expect(mine.cashiers.map((x: any) => x.employeeId)).toEqual([w.s.cashierId]);
    expect(mine.cashiers[0]).toMatchObject({ transactions: 3, workedMinutes: 480, name: 'Cal Cashier' });
    const all = (await rep.cashiers(device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data;
    expect(all.cashiers.map((x: any) => x.employeeId).sort()).toEqual([w.s.cashierId, w.s.managerId].sort());
    expect(all.cashiers.find((x: any) => x.employeeId === w.s.managerId)).toMatchObject({ transactions: 1, voids: 1 }); // the manager sold one and voided the cashier's sale
  });

  it('permissions: the business reports are manager / owner; a cashier is refused; the owner can read them', async () => {
    const { w } = await trade();
    for (const fn of ['sales', 'profit', 'products', 'categories', 'tax', 'payments', 'hourly', 'pulse'] as const) {
      expect([fn, await code((rep as any)[fn](device(w.s), w.s.storeId, w.q('2026-11-02'), w.C))]).toEqual([fn, 'POS_ACTION_FORBIDDEN']);
    }
    expect((await rep.sales(owner(w.s), w.s.storeId, w.q('2026-11-02'), {})).success).toBe(true);
    expect(await code(rep.sales(device(w.s), w.s.storeId, w.q('2026-11-04', '2026-11-02'), w.M))).toBe('RANGE_INVALID');
    expect(await code(rep.sales(device(w.s), w.s.storeId, w.q('2025-01-01', '2026-11-02'), w.M))).toBe('RANGE_TOO_LONG');
  });

  it('pulse: today so far vs the same weekday last week up to the same time; top products; low stock; who is clocked in', async () => {
    const w = await world();
    await w.cost(400);
    const now = new Date();
    await w.sell(2, new Date(now.getTime() - 60_000));
    await w.sell(1, new Date(now.getTime() - 7 * 86_400_000 - 60_000));
    await w.sell(5, new Date(now.getTime() - 7 * 86_400_000 + 3_600_000)); // later in the day last week than "now" → not compared
    await r.posAttendanceStateModel.create({ storeId: w.s.storeId, employeeId: w.s.cashierId, openRecordId: 'x', openSince: now });
    const p = (await rep.pulse(device(w.s), w.s.storeId, {}, w.M)).data;
    expect([p.today.transactions, p.sameDayLastWeek.transactions]).toEqual([1, 1]);
    expect(p.today.netSalesMinor).toBe(2_000);
    expect(p.changePercent.netSalesMinor).toBe(100);
    expect(p.topProducts[0]).toMatchObject({ qty: 2 });
    expect(p.clockedInNow).toBe(1);
  });

  it('every report response states currency + exponent (and the time zone)', async () => {
    const { w } = await trade();
    const out: any[] = [];
    for (const fn of ['sales', 'profit', 'products', 'categories', 'tax', 'payments', 'cashiers', 'hourly'] as const) out.push((await (rep as any)[fn](device(w.s), w.s.storeId, w.q('2026-11-02', '2026-11-04'), w.M)).data);
    out.push((await rep.pulse(device(w.s), w.s.storeId, {}, w.M)).data);
    out.forEach((x, i) => { expect([i, moneyContractViolations(x)]).toEqual([i, []]); expect(x.timeZone).toBe('Asia/Karachi'); });
  });

  it('the daybook takes date=YYYY-MM-DD as a STORE day', async () => {
    const w = await world();
    await r.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(w.sid) }, { $set: { openedAt: pk('2026-11-05', 0, 30) } }); // 19:30 UTC on the 4th
    const d5 = (await cash.daybook(device(w.s), w.s.storeId, { date: '2026-11-05' }, w.M)).data;
    const d4 = (await cash.daybook(device(w.s), w.s.storeId, { date: '2026-11-04' }, w.M)).data;
    expect([d5.shifts.length, d4.shifts.length, d5.timeZone, d5.date]).toEqual([1, 0, 'Asia/Karachi', '2026-11-05']);
  });
});
