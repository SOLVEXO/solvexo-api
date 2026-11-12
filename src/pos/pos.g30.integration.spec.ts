/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { MongoHarness, oidStr, seedStore, startMongoHarness } from './testing/mongo-harness';

/**
 * G3.0 on a real replica-set MongoDB: a refund / void is booked on the shift whose drawer (terminal) PAID it. A cash refund at till 2 lowers till 2's
 * expected cash and refund counters; the original sale's shift on till 1 is not touched; the credit note links both.
 */
jest.setTimeout(240_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const sessions = () => h.repos.registerSessionModel.collection;
const sess = async (id: string): Promise<any> => sessions().findOne({ _id: new Types.ObjectId(id) });

/** Two tills of one store, each with an OPEN shift (till 1 opened with 50, till 2 with 20). */
async function twoTills() {
  const s = await seedStore(h, { stock: 50, price: 10 });
  const svc = makeService();
  const reg1 = s.registerId, reg2 = oidStr();
  const sid1 = String(new Types.ObjectId()), sid2 = String(new Types.ObjectId());
  const base = { storeId: s.storeId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 7_200_000), totalSales: 0, totalTransactions: 0 };
  await sessions().insertMany([
    { _id: new Types.ObjectId(sid1), registerId: reg1, openingCash: 50, ...base },
    { _id: new Types.ObjectId(sid2), registerId: reg2, openingCash: 20, ...base },
  ]);
  const sell = async (method: 'cash' | 'card' = 'cash') => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid1, registerId: reg1, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: method, ...(method === 'card' ? { reference: 'A1' } : {}) } as any, tok(s, 'manager'))) as any).data;
  const close = (sid: string, closingCash: number, slip?: number) => svc.closeSession(s.sellerId, { sessionId: sid, closingCash, ...(slip !== undefined ? { cardTotalFromSlip: slip } : {}) } as any, tok(s, 'manager'));
  return { s, svc, reg1, reg2, sid1, sid2, sell, close };
}

describe('a cash refund at ANOTHER till is booked on the till whose drawer paid it', () => {
  it('till 2 expected cash and refund counters change; till 1 does not; both shift closes are right; the credit note links both', async () => {
    const t = await twoTills();
    const sale = await t.sell('cash'); // 10.00 cash on till 1
    const before1 = await sess(t.sid1);
    expect([before1.cashSales, before1.totalSales, before1.totalTransactions]).toEqual([10, 10, 1]);

    const r: any = await t.svc.refundSale(t.s.sellerId, String(sale._id), { registerId: t.reg2 } as any, tok(t.s, 'manager'));
    expect(r.data.tenders).toEqual([{ method: 'cash', amount: 10 }]);

    const s1 = await sess(t.sid1); const s2 = await sess(t.sid2);
    // the sale's shift is exactly as it was
    expect([s1.cashSales, s1.totalSales, s1.totalTransactions, s1.totalRefunds ?? 0]).toEqual([10, 10, 1, 0]);
    expect([s1.cashSalesMinor, s1.totalSalesMinor]).toEqual([before1.cashSalesMinor, before1.totalSalesMinor]);
    // the paying shift carries the refund and the cash that left its drawer
    expect([s2.totalRefunds, s2.cashSales, s2.totalSales, s2.totalTransactions]).toEqual([10, -10, -10, 0]);
    expect([s2.totalRefundsMinor, s2.cashSalesMinor]).toEqual([1000, -1000]);

    // close both: till 2 holds 20 − 10 = 10; till 1 still holds 50 + 10 = 60 (it was never told about the refund)
    const c2: any = (await t.close(t.sid2, 10)).data;
    expect([c2.expectedCash, c2.cashDifference]).toEqual([10, 0]);
    const c1: any = (await t.close(t.sid1, 60)).data;
    expect([c1.expectedCash, c1.cashDifference]).toEqual([60, 0]);

    const note: any = await h.repos.posCreditNoteModel.findOne({ storeId: t.s.storeId }).lean();
    expect([note.sessionId, note.registerId]).toEqual([t.sid2, t.reg2]);
    expect([note.saleSessionId, note.saleRegisterId]).toEqual([t.sid1, t.reg1]);
    const refund: any = await h.repos.posRefundModel.findOne({ saleId: String(sale._id) }).lean();
    expect([refund.sessionId, refund.registerId, refund.saleSessionId]).toEqual([t.sid2, t.reg2, t.sid1]);
  });

  it('the original shift is already CLOSED: it is not changed after the fact; the open shift of the paying till takes the refund', async () => {
    const t = await twoTills();
    const sale = await t.sell('cash');
    await t.close(t.sid1, 60);
    const closed = await sess(t.sid1);
    await t.svc.refundSale(t.s.sellerId, String(sale._id), { registerId: t.reg2 } as any, tok(t.s, 'manager'));
    const after = await sess(t.sid1);
    expect([after.cashSales, after.totalSales, after.totalRefunds ?? 0, after.expectedCash, after.cashDifference, after.status]).toEqual([closed.cashSales, closed.totalSales, 0, 60, 0, 'closed']);
    expect((await sess(t.sid2)).cashSales).toBe(-10);
  });

  it('a cash refund needs an open shift on the paying till (unknown / closed till → OPEN_SHIFT_REQUIRED, nothing is booked)', async () => {
    const t = await twoTills();
    const sale = await t.sell('cash');
    expect(await code(t.svc.refundSale(t.s.sellerId, String(sale._id), { registerId: oidStr() } as any, tok(t.s, 'manager')))).toBe('OPEN_SHIFT_REQUIRED');
    expect((await sess(t.sid1)).cashSales).toBe(10);
    expect((await h.repos.posRefundModel.countDocuments({ saleId: String(sale._id) }))).toBe(0);
  });
});

describe('a CARD refund across tills follows the same rule', () => {
  it('the paying till\'s card total (expected card / slip) is reduced, the sale\'s till is untouched, both closes reconcile', async () => {
    const t = await twoTills();
    const sale = await t.sell('card');
    const r: any = await t.svc.refundSale(t.s.sellerId, String(sale._id), { registerId: t.reg2 } as any, tok(t.s, 'manager'));
    expect(r.data.tenders[0].method).toBe('card');
    const s1 = await sess(t.sid1); const s2 = await sess(t.sid2);
    expect([s1.cardSales, s1.totalSales, s1.totalRefunds ?? 0]).toEqual([10, 10, 0]);
    expect([s2.cardSales, s2.totalSales, s2.totalRefunds]).toEqual([-10, -10, 10]);
    const c2: any = (await t.close(t.sid2, 20, -10)).data; // till 2's terminal slip shows the −10.00 refund
    expect([c2.cardReconciliation.status, c2.cardReconciliation.expectedCard]).toEqual(['matched', -10]);
    const c1: any = (await t.close(t.sid1, 50, 10)).data;
    expect([c1.cardReconciliation.status, c1.cardReconciliation.expectedCard]).toEqual(['matched', 10]);
  });

  it('the paying till has no open shift: a card refund falls back to the sale\'s shift ONLY while it is open; a closed shift is never touched', async () => {
    const t = await twoTills();
    const a = await t.sell('card');
    await sessions().updateOne({ _id: new Types.ObjectId(t.sid2) }, { $set: { status: 'closed', closedAt: new Date() } }); // till 2 has no open shift
    await t.svc.refundSale(t.s.sellerId, String(a._id), { registerId: t.reg2 } as any, tok(t.s, 'manager'));
    expect([(await sess(t.sid1)).cardSales, (await sess(t.sid1)).totalRefunds]).toEqual([0, 10]); // fallback: the open sale shift
    const refundA: any = await h.repos.posRefundModel.findOne({ saleId: String(a._id) }).lean();
    expect(refundA.sessionId).toBe(t.sid1);

    const b = await t.sell('card');
    await t.close(t.sid1, 50, 10 /* b only: a's 10 was refunded */ - 0);
    const closed = await sess(t.sid1);
    await t.svc.refundSale(t.s.sellerId, String(b._id), { registerId: t.reg2 } as any, tok(t.s, 'manager'));
    const still = await sess(t.sid1);
    expect([still.cardSales, still.totalRefunds, still.cardReconciliation.status]).toEqual([closed.cardSales, closed.totalRefunds, closed.cardReconciliation.status]);
    const refundB: any = await h.repos.posRefundModel.findOne({ saleId: String(b._id) }).lean();
    expect(refundB.sessionId).toBeNull(); // no shift took it — the refund row and the credit note carry every id
  });
});

describe('same till, same shift: exactly as before', () => {
  it('the refund comes off that shift (cash sales, refunds, net sales; transaction count when fully refunded)', async () => {
    const t = await twoTills();
    const sale = await t.sell('cash');
    await t.svc.refundSale(t.s.sellerId, String(sale._id), {} as any, tok(t.s, 'manager'));
    const s1 = await sess(t.sid1);
    expect([s1.cashSales, s1.totalRefunds, s1.totalSales, s1.totalTransactions]).toEqual([0, 10, 0, 0]);
    expect((await sess(t.sid2)).totalRefunds ?? 0).toBe(0);
    const note: any = await h.repos.posCreditNoteModel.findOne({ storeId: t.s.storeId }).lean();
    expect([note.sessionId, note.saleSessionId]).toEqual([t.sid1, t.sid1]);
  });
});

describe('a VOID at another till', () => {
  it('books a refund on the paying till and leaves the sale\'s shift alone; an unknown till is refused for cash', async () => {
    const t = await twoTills();
    const sale = await t.sell('cash');
    expect(await code(t.svc.voidSale(t.s.sellerId, String(sale._id), { registerId: oidStr() } as any, tok(t.s, 'manager')))).toBe('OPEN_SHIFT_REQUIRED');
    const v: any = await t.svc.voidSale(t.s.sellerId, String(sale._id), { registerId: t.reg2, reasonCode: 'cashier_error' } as any, tok(t.s, 'manager'));
    expect(v.data.creditNote.number).toBe('CN-000001');
    const s1 = await sess(t.sid1); const s2 = await sess(t.sid2);
    expect([s1.cashSales, s1.totalSales, s1.totalTransactions, s1.totalRefunds ?? 0]).toEqual([10, 10, 1, 0]);
    expect([s2.cashSales, s2.totalSales, s2.totalRefunds, s2.totalTransactions]).toEqual([-10, -10, 10, 0]);
    const note: any = await h.repos.posCreditNoteModel.findOne({ storeId: t.s.storeId }).lean();
    expect([note.kind, note.sessionId, note.saleSessionId]).toEqual(['void', t.sid2, t.sid1]);
  });

  it('a void on the sale\'s own till and shift (old builds send no register): exactly as before', async () => {
    const t = await twoTills();
    const sale = await t.sell('cash');
    await t.svc.voidSale(t.s.sellerId, String(sale._id), {} as any, tok(t.s, 'manager'));
    const s1 = await sess(t.sid1);
    expect([s1.cashSales, s1.totalSales, s1.totalTransactions]).toEqual([0, 0, 0]);
  });
});
