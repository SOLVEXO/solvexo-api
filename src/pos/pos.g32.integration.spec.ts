/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosInventoryService } from './pos-inventory.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { StockCountSchema } from '../stock-counts/schemas/stock-count.schema';
import { refreshExpiredStock } from '../common/expired-stock.util';
import { allocateLotsFefo, previewLotsFefo, restoreToLots, returnPartsFor } from '../common/lot-allocation.util';
import { moneyContractViolations } from './testing/money-contract';

/** G3.2 on a real replica-set MongoDB: FEFO at sale, expired lots blocked unless a manager overrides (audited), the lot on the sale line, a return back to ITS lot, offline never blocked. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let r: any; let inv: PosInventoryService;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, { stockAdjustmentModel: h.conn.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: h.conn.model('StockLot', StockLotSchema), stockCountModel: h.conn.model('StockCount', StockCountSchema) });
  r = h.repos;
  await r.stockLotModel.init();
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  inv = new PosInventoryService(dbs, svc, new PosAuthorizer(dbs, svc), {} as any, {} as any);
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const day = 86_400_000;
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const lot = (s: Seed, lotNumber: string, qty: number, expiryInDays: number | null, receivedDaysAgo = 10) => ({ _id: new Types.ObjectId(), storeId: s.storeId, productId: s.productId, variantId: s.variantId, lotNumber, quantityReceived: qty, quantityRemaining: qty, costPrice: 1, costPriceMinor: 100, status: 'active', expiryDate: expiryInDays === null ? null : new Date(Date.now() + expiryInDays * day), receivedAt: new Date(Date.now() - receivedDaysAgo * day) });

async function fresh(lots: Array<[string, number, number | null, number?]>, opts: { stockExtra?: number; tracked?: boolean } = {}) {
  const s = await seedStore(h, { stock: 0, price: 10 });
  const total = lots.reduce((t, l) => t + l[1], 0) + (opts.stockExtra ?? 0);
  await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { stock: total, trackLots: opts.tracked !== false, costPrice: 1, costPriceMinor: 100 } });
  if (lots.length) await r.stockLotModel.collection.insertMany(lots.map(([n, q, e, ago]) => lot(s, n, q, e, ago ?? 10)));
  await refreshExpiredStock(r, s.variantId);
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(Date.now() - 7_200_000), openingCash: 50, totalSales: 0, totalTransactions: 0 });
  const sell = async (qty: number, over: any = {}, itemOver: any = {}, opts2: any = {}) => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty, ...itemOver }], paymentMethod: 'cash', ...over } as any, tok(s, 'manager'), opts2)) as any).data;
  return { s, sid, sell };
}
const lotQty = async (s: Seed) => Object.fromEntries((await r.stockLotModel.find({ variantId: s.variantId }).lean()).map((l: any) => [l.lotNumber, l.quantityRemaining]));
const lotStatus = async (s: Seed, n: string) => (await r.stockLotModel.findOne({ variantId: s.variantId, lotNumber: n }).lean()).status;
const stock = async (s: Seed) => (await r.productVariantModel.findById(s.variantId).lean()).stock;
const moves = (s: Seed, q: any = {}) => r.stockMovementModel.find({ storeId: s.storeId, ...q }).sort({ createdAt: 1, _id: 1 }).lean();

describe('FEFO at sale: the lot with the soonest expiry goes first, and the sale line records which lots', () => {
  it('B (2 days) → A (5 days) → the lot with no expiry; quantities, stock, the line and one ledger row per lot all agree', async () => {
    const { s, sell } = await fresh([['A', 3, 5], ['B', 4, 2], ['C', 10, null]]);
    const sale = await sell(8);
    expect(sale.items[0].lots.map((l: any) => [l.lotNumber, l.qty])).toEqual([['B', 4], ['A', 3], ['C', 1]]);
    expect(await lotQty(s)).toEqual({ A: 0, B: 0, C: 9 });
    expect([await lotStatus(s, 'A'), await lotStatus(s, 'B'), await lotStatus(s, 'C')]).toEqual(['depleted', 'depleted', 'active']);
    expect(await stock(s)).toBe(9);
    const m: any[] = await moves(s);
    expect(m.map((x) => [x.type, x.qtyDelta, x.lotId ? 'lot' : 'none']).sort()).toEqual([['sale', -1, 'lot'], ['sale', -3, 'lot'], ['sale', -4, 'lot']]);
    expect(m.reduce((t, x) => t + x.qtyDelta, 0)).toBe(-8);
    expect(sale.items[0].soldExpired).toBe(false);
  });

  it('a variant that does not track lots is untouched by all of this; units beyond the lots (stock from before lots) simply have no lot', async () => {
    const a = await fresh([], { stockExtra: 5, tracked: false }); const sa = await a.sell(2);
    expect(sa.items[0].lots).toBeUndefined();
    const b = await fresh([['A', 2, 3]], { stockExtra: 4 }); const sb = await b.sell(5);
    expect(sb.items[0].lots.map((l: any) => [l.lotNumber, l.qty])).toEqual([['A', 2]]);
    expect(await stock(b.s)).toBe(1);
    expect((await moves(b.s)).map((x: any) => [x.qtyDelta, x.lotId ? 'lot' : 'none']).sort()).toEqual([[-2, 'lot'], [-3, 'none']]);
  });

  it('two tills selling the last units of a lot at once: exactly the stock is sold, never negative, the lot ends at 0 and depleted', async () => {
    const { s, sell } = await fresh([['A', 5, 3]]);
    const res = await Promise.allSettled(Array.from({ length: 12 }, () => sell(1)));
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(5);
    expect(await lotQty(s)).toEqual({ A: 0 });
    expect(await lotStatus(s, 'A')).toBe('depleted');
    expect(await stock(s)).toBe(0);
  });
});

describe('expired lots: blocked at sale unless a manager overrides — audited', () => {
  it('only the expired lot is left → the sale is refused and nothing moves; selling the good units first never touches the expired lot', async () => {
    const { s, sell } = await fresh([['OLD', 5, -3], ['GOOD', 2, 20]]);
    expect(await code(sell(3))).not.toBeNull(); // 2 sellable units
    expect([await stock(s), await lotQty(s)]).toEqual([7, { OLD: 5, GOOD: 2 }]);
    const ok = await sell(2);
    expect(ok.items[0].lots.map((l: any) => l.lotNumber)).toEqual(['GOOD']);
    expect(await lotQty(s)).toEqual({ OLD: 5, GOOD: 0 });
  });

  it('with the override (a manager approved it): good units first, then the expired lot; the line says so and an expired_lot_sold audit names the approver and the lot', async () => {
    const { s, sell } = await fresh([['OLD', 5, -3], ['GOOD', 2, 20]]);
    expect(await code(sell(4, {}, { sellExpired: true }))).toBe('EXPIRED_LOT_APPROVAL_REQUIRED'); // the controller verifies the approval; the service never trusts the flag alone
    const sale = await sell(4, {}, { sellExpired: true }, { expiredApproval: { employeeId: s.managerId, role: 'manager' } });
    expect(sale.items[0].lots.map((l: any) => [l.lotNumber, l.qty, l.expired])).toEqual([['GOOD', 2, false], ['OLD', 2, true]]);
    expect(sale.items[0].soldExpired).toBe(true);
    expect(await lotQty(s)).toEqual({ OLD: 3, GOOD: 0 });
    const au: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'expired_lot_sold' }).lean();
    expect([au.metadata.approvedBy, au.metadata.qty, au.metadata.lots.map((l: any) => l.lotNumber), au.metadata.offline]).toEqual([s.managerId, 4, ['OLD'], false]);
  });

  it('a cashier\'s use of the override needs a manager\'s PIN (the matrix action); with it, it is allowed', async () => {
    const { s } = await fresh([['OLD', 1, -1]]);
    const auth = new PosAuthorizer({ repositories: r } as any, svc);
    const req = { user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd', storeId: s.storeId } } };
    const denied = await auth.authorize(req, { storeId: s.storeId, action: 'inventory.lot.sellExpired', employeeToken: tok(s, 'cashier') }).catch((e) => e.response);
    expect(denied.code).toBe('POS_APPROVAL_REQUIRED');
    const ok = await auth.authorize(req, { storeId: s.storeId, action: 'inventory.lot.sellExpired', employeeToken: tok(s, 'cashier'), approverToken: tok(s, 'manager') });
    expect(ok.approvedBy?.employeeId).toBe(s.managerId);
  });
});

describe('a return goes back to the lot the units came from', () => {
  it('partial returns map onto the lots in the order sold; a depleted lot is active again; a non-restocked line writes nothing; the ledger rows carry the lot', async () => {
    const { s, sell } = await fresh([['A', 1, 6], ['B', 4, 2]]);
    const sale = await sell(5); // B 4 then A 1
    expect(await lotQty(s)).toEqual({ A: 0, B: 0 });
    const line = String(sale.items[0]._id);
    await svc.refundSale(s.sellerId, String(sale._id), { items: [{ saleItemId: line, qty: 3 }] } as any, tok(s, 'manager'));
    expect(await lotQty(s)).toEqual({ A: 0, B: 3 });
    expect(await lotStatus(s, 'B')).toBe('active');
    await svc.refundSale(s.sellerId, String(sale._id), { items: [{ saleItemId: line, qty: 1, restock: false, restockReason: 'spilled' }] } as any, tok(s, 'manager'));
    expect(await lotQty(s)).toEqual({ A: 0, B: 3 }); // not restocked → not back in any lot
    await svc.refundSale(s.sellerId, String(sale._id), { items: [{ saleItemId: line, qty: 1 }] } as any, tok(s, 'manager'));
    expect(await lotQty(s)).toEqual({ A: 1, B: 3 }); // the 5th unit sold was from A
    const ret: any[] = await moves(s, { type: 'return' });
    expect(ret.map((x) => x.qtyDelta).sort()).toEqual([1, 3]);
    expect(ret.every((x) => !!x.lotId)).toBe(true);
  });

  it('a void puts every unit back into its lot; the pure mapping is cumulative and exact', async () => {
    const { s, sell } = await fresh([['A', 3, 4], ['B', 3, 9]]);
    const sale = await sell(5);
    await svc.voidSale(s.sellerId, String(sale._id), {} as any, tok(s, 'manager'));
    expect(await lotQty(s)).toEqual({ A: 3, B: 3 });
    expect(await stock(s)).toBe(6);
    const al = [{ lotId: 'A', qty: 3 }, { lotId: 'B', qty: 2 }];
    expect([returnPartsFor(al, 0, 4), returnPartsFor(al, 4, 1), returnPartsFor(al, 3, 2), returnPartsFor(al, 5, 1)]).toEqual([[{ lotId: 'A', qty: 3 }, { lotId: 'B', qty: 1 }], [{ lotId: 'B', qty: 1 }], [{ lotId: 'B', qty: 2 }], []]);
  });

  it('a failed sale gives its lot units back (compensation), and restoring into a vanished lot is reported, not silently dropped', async () => {
    const { s } = await fresh([['A', 4, 5]]);
    const got = await allocateLotsFefo(r, s.variantId, 3);
    expect(await lotQty(s)).toEqual({ A: 1 });
    const missing = await restoreToLots(r, s.variantId, [...got.allocations.map((a) => ({ lotId: a.lotId, qty: a.qty })), { lotId: String(new Types.ObjectId()), qty: 2 }]);
    expect(await lotQty(s)).toEqual({ A: 4 });
    expect(missing).toHaveLength(1);
  });
});

describe('held sales: lots are taken when the held sale is COMPLETED (and the ledger rows are written then)', () => {
  it('hold → nothing moves; complete → FEFO lots on the line, one ledger row per lot, stock down', async () => {
    const { s, sid, sell } = await fresh([['A', 2, 3], ['B', 5, 30]]);
    const held = await sell(4, { status: 'held' });
    expect([await stock(s), await lotQty(s), (await moves(s)).length]).toEqual([7, { A: 2, B: 5 }, 0]);
    const done: any = (await svc.completeSale(s.sellerId, String(held._id), { paymentMethod: 'cash', amountTendered: 100 } as any, tok(s, 'manager'))).data;
    expect(done.items[0].lots.map((l: any) => [l.lotNumber, l.qty])).toEqual([['A', 2], ['B', 2]]);
    expect([await stock(s), await lotQty(s)]).toEqual([3, { A: 0, B: 3 }]);
    expect((await moves(s)).reduce((t: number, x: any) => t + x.qtyDelta, 0)).toBe(-4);
  });
});

describe('offline: a sale whose goods already left is NEVER blocked — it is flagged for a manager', () => {
  const off = { offline: true, clientCreatedAt: new Date(Date.now() - 3_600_000).toISOString() };
  it('only expired stock is left → the sale is recorded, the line says so, needsReview + expired_lot_sold_offline (Needs attention)', async () => {
    const { s, sell } = await fresh([['OLD', 5, -2]]);
    const sale = await sell(2, off);
    expect(sale.items[0].lots.map((l: any) => [l.lotNumber, l.qty, l.expired])).toEqual([['OLD', 2, true]]);
    expect(sale.needsReview).toBe(true);
    expect(sale.flags.map((f: any) => f.type)).toContain('expired_lot_sold_offline');
    expect(await lotQty(s)).toEqual({ OLD: 3 });
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'expired_lot_sold' })).toBe(1);
  });

  it('the lots cannot cover the quantity (stock that never had a lot / oversold) → recorded, flagged lots_short; and the offline flag "sellExpired" is ignored (no approval is ever asked)', async () => {
    const { s, sell } = await fresh([['A', 2, 5]], { stockExtra: 0 });
    const sale = await sell(5, off, { sellExpired: true });
    expect(sale.items[0].lots.map((l: any) => [l.lotNumber, l.qty])).toEqual([['A', 2]]);
    expect(sale.flags.some((f: any) => f.type === 'lots_short' && f.detail.units === 3)).toBe(true);
    expect(sale.needsReview).toBe(true);
    expect(await stock(s)).toBe(-3); // goods left the shop: stock is allowed to go negative on sync (existing rule)
  });

  it('a replay of the same offline sale (same key) does not take the lot twice', async () => {
    const { s, sell } = await fresh([['A', 5, 5]]);
    await sell(2, { ...off, idempotencyKey: 'dup-1' }); await sell(2, { ...off, idempotencyKey: 'dup-1' }).catch(() => undefined);
    expect(await lotQty(s)).toEqual({ A: 3 });
  });
});

describe('suggestion, expiring-soon and the money contract', () => {
  it('lots/:variant?qty= previews FEFO without writing; expired lots are not offered; not-tracked variants say so', async () => {
    const { s } = await fresh([['A', 3, 5], ['B', 4, 2], ['OLD', 2, -1]]);
    const m = { employee: tok(s, 'cashier') };
    const dev = { user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd', storeId: s.storeId } } };
    const res: any = (await inv.lotsSuggest(dev, s.storeId, s.variantId, 6, m)).data;
    expect(res.allocations.map((a: any) => [a.lotNumber, a.take])).toEqual([['B', 4], ['A', 2]]);
    expect([res.shortBy, res.expiredUnits]).toEqual([0, 2]);
    expect((await inv.lotsSuggest(dev, s.storeId, s.variantId, 20, m)).data.shortBy).toBe(13); // 20 − 7 lot units that are not expired
    expect(await lotQty(s)).toEqual({ A: 3, B: 4, OLD: 2 }); // nothing written
    expect(moneyContractViolations(res)).toEqual([]);
    const plain = await fresh([], { stockExtra: 3, tracked: false });
    const devPlain = { user: { userId: plain.s.sellerId, role: 'seller', posDevice: { deviceId: 'd', storeId: plain.s.storeId } } };
    expect((await inv.lotsSuggest(devPlain, plain.s.storeId, plain.s.variantId, 1, { employee: tok(plain.s, 'cashier') })).data.trackLots).toBe(false);
    expect((await previewLotsFefo(r, s.variantId, 9, { includeExpired: true })).allocations.map((a) => a.lotNumber)).toEqual(['B', 'A', 'OLD']); // expired lots come LAST, and only when asked for
  });

  it('expiring-soon: the summary counts expired / ≤7 d / ≤30 d lots; the stock list has an "expiring" filter and rows carry expired units + the next expiry', async () => {
    const { s } = await fresh([['OLD', 2, -1], ['SOON', 3, 4], ['LATER', 5, 20], ['FAR', 5, 90]]);
    const dev = { user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd', storeId: s.storeId } } };
    expect(await inv.expiringSummary(s.storeId)).toEqual({ expiredLots: 1, expiringIn7Days: 1, expiringIn30Days: 2 });
    const list: any = (await inv.stock(dev, s.storeId, { filter: 'expiring' }, { employee: tok(s, 'manager') })).data;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ trackLots: true, expiredUnits: 2 });
    expect(list.items[0].nextExpiryAt).toBeTruthy();
    const other = await fresh([['FAR', 5, 90]]);
    expect((await inv.stock({ user: { userId: other.s.sellerId, role: 'seller', posDevice: { deviceId: 'd', storeId: other.s.storeId } } }, other.s.storeId, { filter: 'expiring' }, { employee: tok(other.s, 'manager') })).data.items).toHaveLength(0);
  });
});
