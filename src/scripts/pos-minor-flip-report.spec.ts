/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from '../pos/pos.service';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';
import { buildFlipReport, FLIP_PATHS } from './pos-minor-flip-report.lib';

jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const svc = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const dto = (s: Seed, sid: string, over: any = {}) => ({ storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], paymentMethod: 'cash', ...over });
const today = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); };

async function exerciseEveryPath() {
  const p = svc(); const s = await seedStore(h, { stock: 100, price: 10 });
  const sid = String(((await p.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 50 } as any)) as any).data._id);
  await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { openedAt: new Date(Date.now() - 5 * 3600_000) } });
  await p.createSale(s.sellerId, dto(s, sid) as any, undefined); // cash
  const card: any = await p.createSale(s.sellerId, dto(s, sid, { paymentMethod: 'card', payments: [{ method: 'card', amount: 20 }] }) as any, undefined);
  await p.createSale(s.sellerId, dto(s, sid, { paymentMethod: 'card', payments: [{ method: 'card', amount: 12 }, { method: 'cash', amount: 8 }] }) as any, undefined); // split
  await p.refundSale(s.sellerId, String(card.data._id), undefined, tok(s, 'manager'), 'k1'); // full refund
  const big: any = await p.createSale(s.sellerId, dto(s, sid, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] }) as any, undefined);
  const item = ((await h.repos.saleModel.collection.findOne({ _id: new Types.ObjectId(String(big.data._id)) })) as any).items[0];
  await p.refundSale(s.sellerId, String(big.data._id), { items: [{ saleItemId: String(item._id), qty: 1 }] } as any, tok(s, 'manager'), 'k2'); // partial refund
  const held: any = await p.createSale(s.sellerId, dto(s, sid, { status: 'held' }) as any, undefined); // held create
  await p.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'cash' } as any, undefined); // held resume
  const held2: any = await p.createSale(s.sellerId, dto(s, sid, { status: 'held' }) as any, undefined);
  await p.discardHeldSale(s.sellerId, String(held2.data._id), { reason: 'left' }); // held discard
  await p.createSale(s.sellerId, { ...dto(s, sid), offline: true, clientCreatedAt: new Date(Date.now() - 3600_000).toISOString(), idempotencyKey: 'off-1' } as any, undefined); // offline synced
  await p.closeSession(s.sellerId, { sessionId: sid, closingCash: 80, cardTotalFromSlip: 5 } as any, tok(s, 'manager')); // shift close with card variance
  return { s, sid };
}

describe('flip-criteria report (read-only)', () => {
  it('every path exercised, zero mismatches → READY (with a 1-day window for the test)', async () => {
    await exerciseEveryPath();
    const r = await buildFlipReport(h.conn.db!, { from: today(), to: today(), minCleanDays: 1 });
    for (const path of FLIP_PATHS) expect({ path, n: r.pathCounts[path] > 0 }).toEqual({ path, n: true });
    expect(r.pathsMissing).toEqual([]);
    expect(r.mismatches.total).toBe(0);
    expect(r.checkedRows.sales).toBeGreaterThanOrEqual(6);
    expect(r.consecutiveCleanDaysEndingAtTo).toBe(1);
    expect(r.ready).toBe(true);
  });

  it('the 14-day rule: one clean day is NOT enough', async () => {
    await exerciseEveryPath();
    const r = await buildFlipReport(h.conn.db!, { from: new Date(today().getTime() - 13 * 86_400_000), to: today() }); // 14 days, only the last has data
    expect(r.consecutiveCleanDaysEndingAtTo).toBe(14); // the quiet days are clean too…
    expect(r.ready).toBe(true);
    const short = await buildFlipReport(h.conn.db!, { from: new Date(today().getTime() - 5 * 86_400_000), to: today() });
    expect(short.ready).toBe(false);
    expect(short.reasons.join(' ')).toContain('14 required');
  });

  it('a path that was never exercised blocks the flip and is named', async () => {
    const p = svc(); const s = await seedStore(h, { stock: 100, price: 10 });
    const sid = String(((await p.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 50 } as any)) as any).data._id);
    await p.createSale(s.sellerId, dto(s, sid) as any, undefined);
    const r = await buildFlipReport(h.conn.db!, { from: today(), to: today(), minCleanDays: 1 });
    expect(r.ready).toBe(false);
    expect(r.pathsMissing).toEqual(expect.arrayContaining(['card', 'split', 'fullRefund', 'partialRefund', 'heldCreate', 'heldResume', 'heldDiscard', 'offlineSynced', 'shiftCloseCardVariance']));
    expect(r.pathsMissing).not.toContain('cash');
  });

  it('a mismatch counts: tampering a stored minor value is found by the independent re-scan, and a checker audit event is counted too', async () => {
    const { s } = await exerciseEveryPath();
    const sale: any = await h.repos.saleModel.collection.findOne({ storeId: s.storeId, paymentMethod: 'cash', status: 'completed' });
    await h.repos.saleModel.collection.updateOne({ _id: sale._id }, { $set: { totalMinor: 1 } }); // raw tamper (simulates a bug)
    await h.repos.posAuditLogModel.collection.insertOne({ storeId: s.storeId, action: 'money_minor_mismatch', targetType: 'session', targetId: 'x', createdAt: new Date(), metadata: { mismatches: [{ path: 'cashSalesMinor' }] } });
    const r = await buildFlipReport(h.conn.db!, { from: today(), to: today(), minCleanDays: 1 });
    expect(r.mismatches.scanViolations).toBeGreaterThanOrEqual(1);
    expect(r.mismatches.auditEvents).toBe(1);
    expect(r.mismatches.byKind).toMatchObject({ session: 1 });
    expect(r.consecutiveCleanDaysEndingAtTo).toBe(0);
    expect(r.ready).toBe(false);
  });

  it('it never writes (read-only): document counts are identical before and after', async () => {
    await exerciseEveryPath();
    const counts = async () => Promise.all(['sales', 'registersessions', 'pospayments', 'posrefunds', 'posauditlogs'].map((c) => h.conn.db!.collection(c).countDocuments({})));
    const before = await counts();
    await buildFlipReport(h.conn.db!, { from: today(), to: today(), minCleanDays: 1 });
    expect(await counts()).toEqual(before);
  });
});
