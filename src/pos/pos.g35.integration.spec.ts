/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosCashService } from './pos-cash.service';
import { recordCashMovement } from './pos-cash-out.util';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { moneyContractViolations } from './testing/money-contract';

/** G3.5 on a real replica-set MongoDB: cash in / out, expenses + private receipts, and the daybook that must equal the shift close figures exactly. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let cash: PosCashService; let r: any;
const uploaded: any[] = []; const links: any[] = []; const deleted: string[] = [];
const fakeUpload: any = {
  uploadPrivateFile: jest.fn(async (file: any, folder: string) => { uploaded.push({ folder, mimetype: file.mimetype, size: file.size }); return { publicId: `${folder}/f${uploaded.length}`, resourceType: file.mimetype === 'application/pdf' ? 'raw' : 'image', fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype }; }),
  generateExpiringPrivateUrl: jest.fn((publicId: string, resourceType: string, ttl: number, opts: any) => { links.push({ publicId, resourceType, ttl, opts }); return `https://signed.example/${publicId}?ttl=${ttl}`; }),
  deletePrivateFile: jest.fn(async (id: string) => { deleted.push(id); return 'ok'; }),
};
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, {
    posExpenseModel: h.conn.model(schema.PosExpense.name, schema.PosExpenseSchema), posExpenseEventModel: h.conn.model(schema.PosExpenseEvent.name, schema.PosExpenseEventSchema),
  });
  r = h.repos;
  await Promise.all(['posExpenseModel', 'posExpenseEventModel', 'posSettingsModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  cash = new PosCashService(dbs, svc, new PosAuthorizer(dbs, svc), fakeUpload);
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const rid = () => String(new Types.ObjectId());
const EXP: Record<string, number> = { USD: 2, JPY: 0, KWD: 3 };

async function world(currency = 'USD') {
  const s = await seedStore(h, { stock: 500, price: 10, baseCurrency: currency });
  const exp = EXP[currency];
  const open = async (opening = 100, registerId = s.registerId) => {
    const id = String(new Types.ObjectId());
    await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(id), storeId: s.storeId, registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 3_600_000), openingCash: opening, openingCashMinor: Math.round(opening * 10 ** exp), cashSales: 0, cashSalesMinor: 0, totalSales: 0, totalTransactions: 0 });
    return id;
  };
  const sid = await open();
  const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
  const sell = async (qty: number, over: any = {}, session = sid) => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: session, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty }], paymentMethod: 'cash', ...over } as any, tok(s, 'manager'))) as any).data;
  const move = (body: any, who: any = M, req: any = device(s)) => cash.move(req, s.storeId, { type: 'cash_out', category: 'petty', amountMinor: 1000, sessionId: sid, requestId: rid(), ...body }, who);
  const expense = (body: any, who: any = M) => cash.expense(device(s), s.storeId, { category: 'supplies', method: 'cash', amountMinor: 1000, sessionId: sid, requestId: rid(), payee: 'Corner shop', ...body }, who);
  const session = async (id = sid) => r.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(id) });
  const day = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
  const book = async (who: any = M, q: any = {}) => (await cash.daybook(device(s), s.storeId, { ...day, ...q }, who)).data;
  return { s, exp, sid, open, M, C, sell, move, expense, session, book, day };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const file = (buf: Buffer, name = 'r.png') => ({ buffer: buf, size: buf.length, originalname: name, mimetype: 'image/png' }) as any;

describe('cash in / out', () => {
  it('moves the open shift\'s expected cash, with a reason category, a note, who did it — audited', async () => {
    const w = await world();
    const a = (await w.move({ type: 'cash_in', category: 'float_topup', amountMinor: 5000, note: 'more change' })).data;
    const b = (await w.move({ category: 'bank_deposit', amountMinor: 2500 }, w.M)).data;
    expect([a.movement.type, a.duplicate, b.movement.category]).toEqual(['cash_in', false, 'bank_deposit']);
    const sh = await w.session();
    expect(sh.cashAdjustments.map((x: any) => [x.type, x.amountMinor, x.amount, x.category, x.employeeId])).toEqual([['cash_in', 5000, 50, 'float_topup', w.s.managerId], ['cash_out', 2500, 25, 'bank_deposit', w.s.managerId]]);
    expect(sh.cashAdjustments[0].note).toBe('more change');
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: { $in: ['cash_in', 'cash_out'] } })).toBe(2);
    expect(await code(w.move({ category: 'nonsense' }))).toBe('INVALID_CATEGORY');
    expect(await code(w.move({ type: 'cash_in', category: 'petty' }))).toBe('INVALID_CATEGORY'); // a cash-out reason is not a cash-in reason
    expect(await code(w.move({ category: 'other_out' }))).toBe('NOTE_REQUIRED');
    expect(await code(w.move({ amountMinor: 0 }))).toBe('INVALID_AMOUNT');
    expect(await code(w.move({ amountMinor: 10.5 }))).toBe('INVALID_AMOUNT');
    expect(await code(w.move({ requestId: undefined }))).toBe('REQUEST_ID_REQUIRED');
  });

  it('the store\'s limit (D6): a cashier up to it alone, above it a manager\'s PIN; an override moves the line; scales with the currency exponent', async () => {
    for (const [cur, e] of [['USD', 2], ['JPY', 0], ['KWD', 3]] as const) {
      const w = await world(cur);
      const limit = 100 * 10 ** e; // default 100.00 major units
      expect((await w.move({ amountMinor: limit }, w.C)).success).toBe(true);
      expect(await code(w.move({ amountMinor: limit + 1 }, w.C))).toBe('POS_APPROVAL_REQUIRED');
      const ok = await cash.move(device(w.s), w.s.storeId, { type: 'cash_out', category: 'safe_drop', amountMinor: limit + 1, sessionId: w.sid, requestId: rid() }, { employee: tok(w.s, 'cashier'), approver: tok(w.s, 'manager') });
      expect(ok.success).toBe(true);
      expect((await w.session()).cashAdjustments[1].approvedBy).toBe(w.s.managerId);
      await r.posSettingsModel.updateOne({ storeId: w.s.storeId }, { $set: { approvalLimits: { cashOutMinor: 10 } } }, { upsert: true });
      expect(await code(w.move({ amountMinor: 11 }, w.C))).toBe('POS_APPROVAL_REQUIRED');
    }
  });

  it('a replay (a retry, or the offline queue syncing twice) is applied exactly once and keeps the device time; a closed shift refuses it', async () => {
    const w = await world();
    const id = rid(); const at = new Date(Date.now() - 600_000).toISOString();
    const a = (await w.move({ requestId: id, occurredAt: at, amountMinor: 700 })).data;
    const b = (await w.move({ requestId: id, occurredAt: at, amountMinor: 700 })).data;
    const c = (await w.move({ requestId: id, occurredAt: at, amountMinor: 700 })).data;
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, true, true]);
    const sh = await w.session();
    expect(sh.cashAdjustments).toHaveLength(1);
    expect(new Date(sh.cashAdjustments[0].occurredAt).toISOString()).toBe(at);
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'cash_out' })).toBe(1);
    // concurrent replays
    const id2 = rid();
    const res = await Promise.allSettled([1, 2, 3, 4].map(() => w.move({ requestId: id2, amountMinor: 100 })));
    expect(res.every((x) => x.status === 'fulfilled')).toBe(true);
    expect((await w.session()).cashAdjustments).toHaveLength(2);
    expect(await code(w.move({ occurredAt: new Date(Date.now() + 3_600_000).toISOString() }))).toBe('INVALID_DATE');
    await r.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(w.sid) }, { $set: { status: 'closed' } });
    expect(await code(w.move({ amountMinor: 100 }))).toBe('NO_OPEN_SHIFT'); // → Needs attention in the app
    expect(await code(w.move({ sessionId: undefined }))).toBe('NO_OPEN_SHIFT');
  });
});

describe('expenses', () => {
  it('a drawer expense is one document + one cash-out on the open shift (same transaction); bank / other only record; per-store numbers; a retry is not a second expense', async () => {
    const w = await world();
    const a = (await w.expense({ amountMinor: 1250, category: 'transport', payee: 'Taxi' })).data;
    expect([a.expense.number, a.expense.status, a.expense.method, a.expense.amountMinor, a.duplicate]).toEqual(['EXP-000001', 'recorded', 'cash', 1250, false]);
    const sh = await w.session();
    expect(sh.cashAdjustments).toHaveLength(1);
    expect(sh.cashAdjustments[0]).toMatchObject({ type: 'cash_out', amountMinor: 1250, category: 'expense', refType: 'expense', refId: a.expense.id });
    const bank = (await w.expense({ method: 'bank', amountMinor: 9900, category: 'rent', payee: 'Landlord' })).data;
    expect(bank.expense.number).toBe('EXP-000002');
    expect((await w.session()).cashAdjustments).toHaveLength(1); // not from the drawer
    const id = rid();
    const x = (await w.expense({ requestId: id })).data; const y = (await w.expense({ requestId: id })).data;
    expect([x.duplicate, y.duplicate, y.expense.id]).toEqual([false, true, x.expense.id]);
    expect(await r.posExpenseModel.countDocuments({ storeId: w.s.storeId })).toBe(3);
    expect((await w.session()).cashAdjustments).toHaveLength(2);
    const other = await world(); // another store has its own sequence
    expect((await other.expense({})).data.expense.number).toBe('EXP-000001');
    // validation
    expect(await code(w.expense({ category: 'x' }))).toBe('INVALID_CATEGORY');
    expect(await code(w.expense({ method: 'crypto' }))).toBe('INVALID_METHOD');
    expect(await code(w.expense({ category: 'other' }))).toBe('NOTE_REQUIRED');
    expect(await code(w.expense({ requestId: undefined }))).toBe('REQUEST_ID_REQUIRED');
  });

  it('no open shift → a drawer expense is refused and NOTHING is written (no expense, no number used); the closed-shift case too', async () => {
    const w = await world();
    expect(await code(w.expense({ sessionId: undefined }))).toBe('NO_OPEN_SHIFT');
    await r.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(w.sid) }, { $set: { status: 'closed' } });
    expect(await code(w.expense({}))).toBe('NO_OPEN_SHIFT');
    expect(await r.posExpenseModel.countDocuments({ storeId: w.s.storeId })).toBe(0);
    expect((await r.posSettingsModel.findOne({ storeId: w.s.storeId }).lean())?.expenseCounter ?? 0).toBe(0); // the aborted transaction took its number back
    expect((await w.expense({ method: 'bank' })).data.expense.number).toBe('EXP-000001'); // a bank expense needs no shift
  });

  it('the approval limit (D6), a manager approving or rejecting afterwards (append-only events), and a cashier seeing only their own', async () => {
    const w = await world();
    expect(await code(w.expense({ amountMinor: 10_001 }, w.C))).toBe('POS_APPROVAL_REQUIRED'); // default 100.00
    const mine = (await w.expense({ amountMinor: 500 }, w.C)).data.expense;
    const theirs = (await w.expense({ amountMinor: 500 }, w.M)).data.expense;
    const list = (await cash.expenses(device(w.s), w.s.storeId, {}, w.C)).data.expenses;
    expect(list.map((x: any) => x.id)).toEqual([mine.id]);
    expect(await code(cash.expenseGet(device(w.s), w.s.storeId, theirs.id, w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect((await cash.expenses(device(w.s), w.s.storeId, {}, w.M)).data.expenses).toHaveLength(2);
    expect(await code(cash.expenseDecide(device(w.s), w.s.storeId, mine.id, { decision: 'approve' }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(cash.expenseDecide(device(w.s), w.s.storeId, mine.id, { decision: 'reject' }, w.M))).toBe('NOTE_REQUIRED');
    expect((await cash.expenseDecide(device(w.s), w.s.storeId, mine.id, { decision: 'reject', note: 'no receipt' }, w.M)).data.expense.status).toBe('rejected');
    expect(await code(cash.expenseDecide(device(w.s), w.s.storeId, mine.id, { decision: 'approve' }, w.M))).toBe('ALREADY_DECIDED');
    expect((await cash.expenseDecide(device(w.s), w.s.storeId, theirs.id, { decision: 'approve' }, w.M)).data.expense.status).toBe('approved');
    // append-only: the expense and its events cannot be edited or deleted
    await expect(r.posExpenseModel.updateOne({ _id: mine.id }, { $set: { amountMinor: 1 } })).rejects.toThrow(/append-only/);
    await expect(r.posExpenseEventModel.deleteMany({})).rejects.toThrow(/append-only/);
    // a rejection moves no cash back: the money already left the drawer
    expect((await w.session()).cashAdjustments).toHaveLength(2);
  });
});

describe('receipt photos: private, by content, expiring links, audited', () => {
  it('accepts a real PNG (by its bytes), refuses a renamed text file / oversize, stores it privately, and serves a ≤ 5-minute link only to a manager or the person who recorded it', async () => {
    const w = await world();
    const mine = (await w.expense({ amountMinor: 500 }, w.C)).data.expense;
    expect(await code(cash.receiptUpload(device(w.s), w.s.storeId, mine.id, file(Buffer.from('<html>not an image</html>'), 'photo.jpg'), w.C))).toBe('FILE_TYPE');
    expect(await code(cash.receiptUpload(device(w.s), w.s.storeId, mine.id, undefined, w.C))).toBe('FILE_REQUIRED');
    expect(await code(cash.receiptUpload(device(w.s), w.s.storeId, mine.id, file(Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])), w.C))).toBe('FILE_TOO_LARGE');
    expect(uploaded).toHaveLength(0); // nothing reached storage
    const out = (await cash.receiptUpload(device(w.s), w.s.storeId, mine.id, file(PNG, 'whatever.txt'), w.C)).data.expense;
    expect(out.hasReceipt).toBe(true);
    expect(uploaded[0]).toMatchObject({ folder: `private/expense-receipts/${w.s.storeId}`, mimetype: 'image/png' });
    expect(JSON.stringify(out)).not.toMatch(/publicId|signed|http/); // never exposed
    const link = (await cash.receiptLink(device(w.s), w.s.storeId, mine.id, w.M)).data;
    expect([link.expiresInSeconds, link.mimeType, links.at(-1).ttl, links.at(-1).opts.inline]).toEqual([300, 'image/png', 300, true]);
    expect((await cash.receiptLink(device(w.s), w.s.storeId, mine.id, w.C)).data.url).toContain('signed.example'); // the recorder
    const theirs = (await w.expense({ amountMinor: 500 }, w.M)).data.expense;
    expect(await code(cash.receiptLink(device(w.s), w.s.storeId, theirs.id, w.C))).toBe('POS_ACTION_FORBIDDEN'); // someone else's
    expect(await code(cash.receiptLink(device(w.s), w.s.storeId, theirs.id, w.M))).toBe('NO_RECEIPT');
    expect(await code(cash.receiptUpload(device(w.s), w.s.storeId, theirs.id, file(PNG), w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'expense_receipt_viewed' })).toBe(2);
    // a PDF is fine too; the newest receipt wins
    await cash.receiptUpload(device(w.s), w.s.storeId, mine.id, file(Buffer.from('%PDF-1.4\n...'), 'x.pdf'), w.M);
    expect((await cash.receiptLink(device(w.s), w.s.storeId, mine.id, w.M)).data.mimeType).toBe('application/pdf');
  });
});

describe('the daybook equals the shift close figures — exactly', () => {
  /** every kind of cash movement on two tills, in one currency */
  async function busyDay(currency: string) {
    const w = await world(currency);
    const e = w.exp; const p = (major: number) => Math.round(major * 10 ** e);
    const sid2 = await w.open(50, String(new Types.ObjectId())); // a second till, with its own shift
    const first = await w.sell(2, { amountTendered: 40 });                                  // cash sale (with change) at till 1
    await w.sell(1, { paymentMethod: 'card' });                                             // card: not drawer cash
    await w.sell(3, { payments: [{ method: 'cash', amount: 10 }, { method: 'card', amount: 20 }] }); // split tender
    const toRefund = await w.sell(4);
    const toVoid = await w.sell(1);
    await svc.refundSale(w.s.sellerId, String(toRefund._id), { items: [{ saleItemId: String(toRefund.items[0]._id), qty: 1 }] } as any, tok(w.s, 'manager')); // partial cash refund, same till
    await svc.voidSale(w.s.sellerId, String(toVoid._id), { reason: 'oops' }, tok(w.s, 'manager'));                                                     // void of a cash sale
    const cross = await w.sell(2);                                                                                                                     // sold at till 1 …
    await svc.refundSale(w.s.sellerId, String(cross._id), { registerId: (await r.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(sid2) })).registerId } as any, tok(w.s, 'manager')); // … refunded at till 2
    await w.move({ type: 'cash_in', category: 'float_topup', amountMinor: p(20) });
    await w.move({ category: 'safe_drop', amountMinor: p(30) });
    await w.expense({ amountMinor: p(5), category: 'supplies' });
    await recordCashMovement(r.registerSessionModel, undefined, { storeId: w.s.storeId, sessionId: w.sid, amountMinor: p(12), exp: e, reason: 'Supplier payment — Acme', employeeId: w.s.managerId, category: 'supplier_payment', refType: 'supplier_payment', refId: 'pay1' });
    await w.expense({ amountMinor: p(7), method: 'bank' }); // never touches the drawer
    return { w, sid2, first, p };
  }

  for (const cur of ['USD', 'JPY', 'KWD']) {
    it(`${cur}: every shift's running balance = the shift's own expected cash, line totals = its counters (cross-till refund, void, change, split tender, expense, supplier payment)`, async () => {
      const { w, sid2 } = await busyDay(cur);
      const book = await w.book();
      expect(book.shifts).toHaveLength(2);
      for (const sh of book.shifts) {
        expect([sh.sessionId, sh.reconciled, sh.unreconciledMinor]).toEqual([sh.sessionId, true, 0]);
        expect(sh.lines.at(-1).runningMinor).toBe(sh.expectedCashMinor);
        expect(sh.expectedCashMinor).toBe(sh.shiftExpectedCashMinor);
        expect(sh.lines[0]).toMatchObject({ type: 'opening' });
        // the running balance is a real running sum
        let run = 0; for (const l of sh.lines) { run += l.amountMinor; expect(l.runningMinor).toBe(run); }
      }
      const one = book.shifts.find((x: any) => x.sessionId === w.sid);
      const two = book.shifts.find((x: any) => x.sessionId === sid2);
      expect(one.cashRefundsMinor).toBeGreaterThan(0); // the partial refund + the void
      expect(two.cashRefundsMinor).toBeGreaterThan(0); // the cross-till refund is on the PAYING till
      expect(two.cashSalesMinor).toBe(0);
      expect(one.expensesMinor).toBeGreaterThan(0); expect(one.supplierPaymentsMinor).toBeGreaterThan(0); expect(one.cashInMinor).toBeGreaterThan(0); expect(one.cashOutMinor).toBeGreaterThan(0);
      expect(one.lines.filter((l: any) => l.type === 'expense')).toHaveLength(1); // the bank expense is not a drawer line
      // the shift's stored counters say the same, field by field
      const s1 = await w.session(w.sid); const s2 = await w.session(sid2);
      expect(one.cashSalesMinor - one.cashRefundsMinor).toBe(s1.cashSalesMinor);
      expect(two.cashSalesMinor - two.cashRefundsMinor).toBe(s2.cashSalesMinor);
      // close both shifts with a count that differs from expected: the daybook shows the SAME expected and variance as the close report
      for (const [id, sh] of [[w.sid, one], [sid2, two]] as const) {
        const counted = (sh.expectedCashMinor - 3 * 10 ** w.exp) / 10 ** w.exp; // 3.00 short
        const res: any = await svc.closeSession(w.s.sellerId, { sessionId: id, closingCash: counted } as any, tok(w.s, 'manager'));
        expect(res.success).toBe(true);
      }
      const after = await w.book();
      for (const sh of after.shifts) {
        const closed = await w.session(sh.sessionId);
        expect(sh.status).toBe('closed');
        expect(sh.expectedCashMinor).toBe(Math.round(closed.expectedCash * 10 ** w.exp)); // = the close report's expected cash
        expect(sh.countedMinor).toBe(Math.round(closed.closingCash * 10 ** w.exp));
        expect(sh.varianceMinor).toBe(Math.round(closed.cashDifference * 10 ** w.exp));
        expect(sh.varianceMinor).toBe(-3 * 10 ** w.exp);
        expect(sh.reconciled).toBe(true);
      }
      expect(after.totals.varianceMinor).toBe(-6 * 10 ** w.exp);
      expect(moneyContractViolations(after)).toEqual([]);
      expect(after.currency).toBe(cur); expect(after.currencyExponent).toBe(w.exp);
    });
  }

  it('a cashier sees only the shifts they opened; register + range filters; an offline movement keeps its own time in the order', async () => {
    const w = await world();
    const otherSid = await w.open(10, String(new Types.ObjectId()));
    await r.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(otherSid) }, { $set: { employeeId: w.s.managerId } });
    const mine = await w.book(w.C);
    expect(mine.ownShiftsOnly).toBe(true);
    expect(mine.shifts.map((s: any) => s.sessionId)).toEqual([w.sid]);
    expect((await w.book(w.M)).shifts).toHaveLength(2);
    expect((await w.book(w.M, { registerId: w.s.registerId })).shifts.map((s: any) => s.sessionId)).toEqual([w.sid]);
    expect((await cash.daybook(owner(w.s), w.s.storeId, w.day, {})).data.shifts).toHaveLength(2);
    expect((await w.book(w.M, { from: new Date(Date.now() + 86_400_000).toISOString(), to: new Date(Date.now() + 2 * 86_400_000).toISOString() })).shifts).toEqual([]);
    expect(await code(cash.daybook(device(w.s), w.s.storeId, { from: 'x', to: 'y' }, w.M))).toBe('INVALID_DATE');
    expect(await code(cash.daybook(device(w.s), w.s.storeId, { from: w.day.to, to: w.day.from }, w.M))).toBe('RANGE_REQUIRED');
    // device time ordering: a movement made 30 minutes ago but synced now sits BEFORE one made 5 minutes ago
    await w.move({ requestId: rid(), amountMinor: 300, occurredAt: new Date(Date.now() - 300_000).toISOString() });
    await w.move({ requestId: rid(), amountMinor: 200, occurredAt: new Date(Date.now() - 1_800_000).toISOString() });
    const lines = (await w.book(w.M)).shifts.find((s: any) => s.sessionId === w.sid).lines.filter((l: any) => l.type === 'cash_out');
    expect(lines.map((l: any) => l.amountMinor)).toEqual([-200, -300]);
  });

  it('a mismatch is never hidden: if a counter and the lines disagree the shift says so (unreconciled)', async () => {
    const w = await world();
    await w.sell(2);
    await r.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(w.sid) }, { $inc: { cashSalesMinor: 500 } }); // a counter drifts
    const sh = (await w.book()).shifts[0];
    expect([sh.reconciled, sh.unreconciledMinor]).toEqual([false, 500]);
  });
});
