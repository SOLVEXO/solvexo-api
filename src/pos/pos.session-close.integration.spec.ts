/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { MongoHarness, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/**
 * Closing a register against a REAL MongoDB: owner force-close math/audit/ownership, the close-vs-force-close race
 * (the force close used to overwrite a shift the cashier had just counted and closed), and that a closed shift
 * takes no new online sale.
 */
jest.setTimeout(120_000);

let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const cashierToken = (s: Seed) => jwt.sign({ employeeId: s.cashierId, storeId: s.storeId, role: 'cashier', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const open = async (svc: PosService, s: Seed, openingCash = 0) =>
  String(((await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash } as any)) as any).data._id);
const sell = (svc: PosService, s: Seed, sessionId: string) =>
  svc.createSale(s.sellerId, { storeId: s.storeId, sessionId, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: 'cash' } as any, cashierToken(s));
const raw = async (id: string): Promise<any> => h.repos.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(id) });

describe('forceCloseSession', () => {
  it('expected cash = opening + cash sales + cash-in − cash-out; records who/why; audited; counted cash stays unset', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s, 100);
    await sell(svc, s, sid); await sell(svc, s, sid); // 2 × 10 cash
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { cashAdjustments: [{ type: 'cash_in', amount: 50 }, { type: 'cash_out', amount: 30 }] } });

    const res: any = await svc.forceCloseSession(s.sellerId, sid, { reason: 'Till stuck' } as any);
    expect(res.data).toMatchObject({ status: 'closed', expectedCash: 140, forceClosedBy: s.sellerId, forceCloseReason: 'Till stuck' });
    expect((await raw(sid))).toMatchObject({ status: 'closed', closingCash: null, cashDifference: null });
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'session_force_closed', targetId: sid })).toBe(1);
  });

  it('only the store owner can force-close, a closed shift cannot be force-closed again, and it takes no further online sale', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s);
    await expect(svc.forceCloseSession(new Types.ObjectId().toString(), sid, {} as any)).rejects.toBeDefined();
    expect((await raw(sid)).status).toBe('open'); // a stranger changed nothing

    await svc.forceCloseSession(s.sellerId, sid, {} as any);
    await expect(svc.forceCloseSession(s.sellerId, sid, {} as any)).rejects.toMatchObject({ status: 404 });

    const before = await stockOf(h, s.variantId);
    await expect(sell(svc, s, sid)).rejects.toBeDefined();
    expect(await stockOf(h, s.variantId)).toBe(before); // refused sale took no stock
    expect(await h.repos.saleModel.countDocuments({})).toBe(0);
  });

  it('racing the cashier\'s normal close: exactly one applies and the cashier\'s counted cash is never overwritten', async () => {
    for (let i = 0; i < 5; i++) { // the window is tiny — repeat so a missing guard shows up reliably
      await h.reset();
      const svc = makeService();
      const s = await seedStore(h, { stock: 10, price: 10 });
      const sid = await open(svc, s, 100);

      const [a, b] = await Promise.allSettled([
        svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 100 } as any),
        svc.forceCloseSession(s.sellerId, sid, { reason: 'race' } as any),
      ]);
      expect([a.status, b.status].filter((x) => x === 'fulfilled')).toHaveLength(1);

      const doc = await raw(sid);
      if (a.status === 'fulfilled') {
        expect(doc.closingCash).toBe(100); // the counted cash survived
        expect(doc.forceClosedBy ?? null).toBeNull();
      } else {
        expect(doc.forceClosedBy).toBe(s.sellerId);
      }
      expect(await h.repos.posAuditLogModel.countDocuments({ action: { $in: ['session_closed', 'session_force_closed'] }, targetId: sid })).toBe(1);
      const loser = a.status === 'rejected' ? a : (b as PromiseRejectedResult);
      expect(loser.reason.getResponse?.().code ?? loser.reason.constructor.name).toMatch(/SESSION_ALREADY_CLOSED|NotFoundException/);
    }
  });
});
