/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { MongoHarness, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/**
 * Phase 5C against a REAL MongoDB: offline-synced sales (device timestamp, window, session period, plan active AT the
 * sale time, oversell rule, price drift, duplicate sync), settingsVersion pricing, quote, review and discard.
 */
jest.setTimeout(120_000);

let h: MongoHarness;
const HOUR = 3_600_000;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); delete process.env.POS_OFFLINE_MAX_HOURS; process.env.POS_ENTITLEMENT_ENFORCED = 'true'; });
afterAll(() => { delete process.env.POS_ENTITLEMENT_ENFORCED; });

const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
beforeEach(() => activityLog.log.mockClear());
const makeService = () => new PosService({ repositories: h.repos } as any, activityLog as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;

const mgrToken = (s: Seed, opts: { iat?: number; exp?: number } = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee', iat: opts.iat ?? now, exp: opts.exp ?? now + 12 * 3600 }, 'test-secret');
};
const cashierToken = (s: Seed) => jwt.sign({ employeeId: s.cashierId, storeId: s.storeId, role: 'cashier', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });

async function open(svc: PosService, s: Seed, openedAgoMs = 0, openingCash = 0) {
  const res: any = await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash } as any);
  const id = String(res.data._id);
  if (openedAgoMs) await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { openedAt: new Date(Date.now() - openedAgoMs) } });
  return id;
}
const offlineDto = (s: Seed, sessionId: string, agoMs: number, over: any = {}) => ({
  storeId: s.storeId, sessionId, registerId: s.registerId, employeeId: s.cashierId,
  items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: 'cash',
  offline: true, clientCreatedAt: new Date(Date.now() - agoMs).toISOString(), ...over,
});
const code = async (p: Promise<any>) => { try { await p; return 'NO_ERROR'; } catch (e: any) { return e.getResponse?.().code ?? e.message; } };
const session = async (id: string): Promise<any> => h.repos.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(id) });
const rawSale = async (id: string): Promise<any> => h.repos.saleModel.collection.findOne({ _id: new Types.ObjectId(id) });

describe('offline-synced sales: timestamp, window, session period', () => {
  it('keeps the device time as createdAt, stores it separately from receivedAt, and counts into the session', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 20 });
    const sid = await open(svc, s, 5 * HOUR);
    const madeAt = Date.now() - 2 * HOUR;
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 2 * HOUR, { idempotencyKey: 'off-1' }) as any, undefined);
    const doc = await rawSale(String(res.data._id));
    expect(doc.isOffline).toBe(true);
    expect(Math.abs(new Date(doc.createdAt).getTime() - madeAt)).toBeLessThan(2000); // reports/receipts show WHEN it happened
    expect(Math.abs(new Date(doc.clientCreatedAt).getTime() - madeAt)).toBeLessThan(2000);
    expect(Math.abs(new Date(doc.receivedAt).getTime() - Date.now())).toBeLessThan(5000); // server receipt time kept apart
    expect(doc.settingsVersion).toBe(1);
    expect(await session(sid)).toMatchObject({ cashSales: 20, totalSales: 20, totalTransactions: 1 });
  });

  it('rejects a sale dated in the future (beyond clock skew) and one older than the offline window', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s, 100 * HOUR);
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, -10 * 60_000) as any, undefined))).toBe('OFFLINE_SALE_FROM_FUTURE');
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, 73 * HOUR) as any, undefined))).toBe('OFFLINE_SALE_TOO_OLD');
    expect(await h.repos.saleModel.countDocuments({})).toBe(0);
    expect(await stockOf(h, s.variantId)).toBe(10);
    // a couple of minutes ahead is just clock skew
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, -2 * 60_000) as any, undefined))).toBe('NO_ERROR');
  });

  it('the offline window is configurable (POS_OFFLINE_MAX_HOURS)', async () => {
    process.env.POS_OFFLINE_MAX_HOURS = '1';
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s, 10 * HOUR);
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, 2 * HOUR) as any, undefined))).toBe('OFFLINE_SALE_TOO_OLD');
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, 30 * 60_000) as any, undefined))).toBe('NO_ERROR');
  });

  it('an offline sale needs its timestamp', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s);
    expect(await code(svc.createSale(s.sellerId, { ...offlineDto(s, sid, 0), clientCreatedAt: undefined } as any, undefined))).toBe('OFFLINE_SALE_NO_TIMESTAMP');
  });

  it('an ordinary ONLINE sale ignores clientCreatedAt (always server time)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, { ...offlineDto(s, sid, 10 * HOUR), offline: false } as any, undefined);
    expect(res.data.isOffline).toBe(false);
    expect(Math.abs(new Date(res.data.createdAt).getTime() - Date.now())).toBeLessThan(5000);
  });

  it('must fall within the session\'s open period (before it opened → rejected)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s, 1 * HOUR); // opened 1h ago
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, 3 * HOUR) as any, undefined))).toBe('OFFLINE_SALE_OUTSIDE_SESSION');
  });

  it('a sale into a session that has CLOSED since is accepted if made while it was open — and the session\'s expected cash follows', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 25 });
    const sid = await open(svc, s, 5 * HOUR, 100);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { openedAt: new Date(Date.now() - 5 * HOUR) } });
    // close the shift an hour ago with the count the cashier entered (100 opening + nothing sold yet)
    const closed: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 100 } as any);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { closedAt: new Date(Date.now() - 1 * HOUR) } });
    expect(closed.data.cashDifference).toBe(0);

    // the sale was made 2h ago (session open) but only reaches the server now
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 2 * HOUR) as any, undefined);
    expect(res.data.status).toBe('completed');
    const sess = await session(sid);
    expect(sess).toMatchObject({ status: 'closed', cashSales: 25, expectedCash: 125 });
    expect(sess.cashDifference).toBe(-25); // the count (100) pre-dated the sync of a 25 cash sale — visible, not hidden

    // …but a sale dated AFTER the session closed is refused
    expect(await code(svc.createSale(s.sellerId, offlineDto(s, sid, 10 * 60_000) as any, undefined))).toBe('OFFLINE_SALE_OUTSIDE_SESSION');
  });
});

describe('entitlement is judged at the time the offline sale was MADE', () => {
  const guard = () => new PosEntitlementGuard({ repositories: h.repos } as any);
  const ctx = (storeId: string, body: any) => ({ switchToHttp: () => ({ getRequest: () => ({ params: {}, body: { storeId, ...body }, method: 'POST', route: { path: '/api/pos/sales' } }) }) }) as any;
  const plan = (s: Seed, purchasedAgoMs: number, expiredAgoMs: number) =>
    h.repos.posPurchaseModel.collection.insertOne({ storeId: s.storeId, sellerId: s.sellerId, planId: 'p', planNameSnapshot: 'Pro', priceSnapshot: 1, currencySnapshot: 'USD', durationInDaysSnapshot: 3, stripeCheckoutSessionId: `cs_${Math.random()}`, purchasedAt: new Date(Date.now() - purchasedAgoMs), expiresAt: new Date(Date.now() - expiredAgoMs) });

  it('late sync AFTER the plan expired is accepted when the sale was made while it was active', async () => {
    const s = await seedStore(h);
    await plan(s, 60 * HOUR, 10 * HOUR); // active from 60h ago until 10h ago — EXPIRED now
    const madeWhileActive = new Date(Date.now() - 30 * HOUR).toISOString();
    await expect(guard().canActivate(ctx(s.storeId, { offline: true, clientCreatedAt: madeWhileActive }))).resolves.toBe(true);
  });

  it('…but not when it was made after the plan had already expired, and an ONLINE sale after expiry is blocked', async () => {
    const s = await seedStore(h);
    await plan(s, 60 * HOUR, 10 * HOUR);
    const madeAfterExpiry = new Date(Date.now() - 5 * HOUR).toISOString();
    await expect(guard().canActivate(ctx(s.storeId, { offline: true, clientCreatedAt: madeAfterExpiry }))).rejects.toMatchObject({ response: { code: 'POS_PLAN_REQUIRED' } });
    await expect(guard().canActivate(ctx(s.storeId, {}))).rejects.toMatchObject({ response: { code: 'POS_PLAN_REQUIRED' } });
  });

  it('the same offline window applies in the guard (too old / future are rejected there too)', async () => {
    const s = await seedStore(h);
    await plan(s, 200 * HOUR, 0);
    await expect(guard().canActivate(ctx(s.storeId, { offline: true, clientCreatedAt: new Date(Date.now() - 100 * HOUR).toISOString() }))).rejects.toMatchObject({ response: { code: 'OFFLINE_SALE_TOO_OLD' } });
    await expect(guard().canActivate(ctx(s.storeId, { offline: true, clientCreatedAt: new Date(Date.now() + HOUR).toISOString() }))).rejects.toMatchObject({ response: { code: 'OFFLINE_SALE_FROM_FUTURE' } });
  });

  it('a revoked plan still covers sales made before the revoke', async () => {
    const s = await seedStore(h);
    // purchased 20h ago, revoked 5h ago (expiresAt set to the revoke time)
    await plan(s, 20 * HOUR, 5 * HOUR);
    await expect(guard().canActivate(ctx(s.storeId, { offline: true, clientCreatedAt: new Date(Date.now() - 10 * HOUR).toISOString() }))).resolves.toBe(true);
  });
});

describe('offline stock rule: record the sale, allow negative stock, flag it', () => {
  it('an oversold offline sale is RECORDED (stock goes negative), flagged, audited and logged as inventory activity', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 1, price: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }], idempotencyKey: 'over-1' }) as any, undefined);

    expect(res.data.status).toBe('completed');
    expect(res.data.needsReview).toBe(true);
    expect(JSON.parse(JSON.stringify(res.data.flags))).toEqual([{ type: 'oversold_on_sync', detail: expect.objectContaining({ requested: 3, available: 1, sku: 'TEA-1' }) }]);
    expect(await stockOf(h, s.variantId)).toBe(-2);
    const audit = await h.repos.posAuditLogModel.collection.find({ action: 'sale_oversold_offline' }).toArray();
    expect(audit).toHaveLength(1);
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ category: 'inventory', action: 'inventory_oversell', targetId: s.variantId }));
    expect(await session(sid)).toMatchObject({ totalSales: 30, totalTransactions: 1 });
  });

  it('the strict no-negative rule is UNCHANGED for ordinary online sales', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 1 });
    const sid = await open(svc, s);
    await expect(svc.createSale(s.sellerId, { ...offlineDto(s, sid, 0), offline: false, items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }] } as any, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(await stockOf(h, s.variantId)).toBe(1);
    expect(await h.repos.saleModel.countDocuments({})).toBe(0);
  });

  it('a normal in-stock offline sale is not flagged', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR) as any, undefined);
    expect(res.data.needsReview).toBe(false);
    expect(JSON.parse(JSON.stringify(res.data.flags))).toEqual([]);
    expect(await stockOf(h, s.variantId)).toBe(9);
  });

  it('syncing the SAME key twice (even concurrently) records ONE sale and takes stock ONCE — including the negative path', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 0, price: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    const dto = offlineDto(s, sid, HOUR, { idempotencyKey: 'dup-sync', items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] });
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => svc.createSale(s.sellerId, dto as any, undefined)));
    expect(await h.repos.saleModel.countDocuments({})).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(-2);
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(new Set(ok.map((r) => String(r.value.data._id))).size).toBe(1);
    // a later replay returns the same sale untouched
    const again: any = await svc.createSale(s.sellerId, dto as any, undefined);
    expect(String(again.data._id)).toBe(String(ok[0].value.data._id));
    expect(await stockOf(h, s.variantId)).toBe(-2);
  });
});

describe('price changed while the device was offline', () => {
  it('is recorded at the SERVER price and flagged — the sale is not rejected; the shortfall is visible', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    // the device charged 10.00 (old price), then the catalog price went up to 12.00 before the sync
    await h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { price: 12 } });
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { clientTotal: 10, amountTendered: 10 }) as any, undefined);
    expect(res.data.total).toBe(12);
    expect(res.data.paymentShortfall).toBe(2);
    expect(res.data.needsReview).toBe(true);
    expect(res.data.flags.map((f: any) => f.type).sort()).toEqual(['payment_shortfall', 'price_changed_while_offline']);
    expect(res.data.payments[0]).toMatchObject({ method: 'cash', amount: 10 });
    expect(await session(sid)).toMatchObject({ cashSales: 10, totalSales: 12 }); // the drawer holds what was really taken
  });

  it('…but an ONLINE sale with a wrong total is still rejected (TOTAL_MISMATCH = tampering or a client bug)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s);
    expect(await code(svc.createSale(s.sellerId, { ...offlineDto(s, sid, 0), offline: false, clientTotal: 5 } as any, undefined))).toBe('TOTAL_MISMATCH');
  });
});

describe('offline discount authorisation is judged at sale time', () => {
  it('a manager token that has EXPIRED since the sale (but was valid then) still authorises the synced discount', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    const sid = await open(svc, s, 30 * HOUR);
    const now = Math.floor(Date.now() / 1000);
    const token = mgrToken(s, { iat: now - 26 * 3600, exp: now - 14 * 3600 }); // valid from 26h to 14h ago → EXPIRED now
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 20 * HOUR, { discountType: 'percent', discountValue: 10 }) as any, token);
    expect(res.data.discount).toBe(10);
  });

  it('a token that was NOT valid when the sale was made is refused', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    const sid = await open(svc, s, 30 * HOUR);
    const now = Math.floor(Date.now() / 1000);
    const token = mgrToken(s, { iat: now - 3600, exp: now + 3600 }); // minted 1h ago — the sale was 20h ago
    await expect(svc.createSale(s.sellerId, offlineDto(s, sid, 20 * HOUR, { discountType: 'percent', discountValue: 10 }) as any, token)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an expired token is still refused for an ONLINE discount', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    const sid = await open(svc, s);
    const now = Math.floor(Date.now() / 1000);
    await expect(svc.createSale(s.sellerId, { ...offlineDto(s, sid, 0), offline: false, discountType: 'percent', discountValue: 10 } as any, mgrToken(s, { iat: now - 7200, exp: now - 3600 }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('settingsVersion: sales are priced with the version the device used', () => {
  it('a tax change bumps the version, keeps history, and a sale priced with the OLD version gets the OLD rate', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 20, price: 100, taxRate: 0.1 });
    const sid = await open(svc, s);
    expect(((await svc.getPosSettings(s.sellerId, s.storeId)) as any).data.settingsVersion).toBe(1);

    await svc.updatePosSettings(s.sellerId, s.storeId, { taxRate: 0.2 } as any);
    const cur: any = (await svc.getPosSettings(s.sellerId, s.storeId)).data;
    expect(cur).toMatchObject({ settingsVersion: 2, taxRate: 0.2 });
    const history = await h.repos.posSettingsVersionModel.collection.find({ storeId: s.storeId }).sort({ version: 1 }).toArray();
    expect(history.map((x: any) => [x.version, x.taxRate])).toEqual([[1, 0.1], [2, 0.2]]);
    expect(history[0].supersededAt).toBeTruthy();
    expect(history[1].supersededAt).toBeNull();

    const old: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, settingsVersion: 1, clientTotal: 110 }) as any, undefined);
    expect(old.data).toMatchObject({ tax: 10, total: 110, settingsVersion: 1, taxRate: 0.1 });
    const now: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, clientTotal: 120 }) as any, undefined);
    expect(now.data).toMatchObject({ tax: 20, total: 120, settingsVersion: 2 });
    const explicit: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, settingsVersion: 2, clientTotal: 120 }) as any, undefined);
    expect(explicit.data.settingsVersion).toBe(2);
  });

  it('an unchanged tax rate does NOT bump the version; other settings never do', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 5, taxRate: 0.1 });
    await svc.updatePosSettings(s.sellerId, s.storeId, { taxRate: 0.1, receiptFooter: 'hi' } as any);
    await svc.updatePosSettings(s.sellerId, s.storeId, { receiptHeader: 'yo' } as any);
    expect(((await svc.getPosSettings(s.sellerId, s.storeId)) as any).data.settingsVersion).toBe(1);
  });

  it('an unknown version, or one superseded longer ago than the offline window, falls back to the CURRENT settings', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 20, price: 100, taxRate: 0.1 });
    const sid = await open(svc, s);
    await svc.getPosSettings(s.sellerId, s.storeId);
    await svc.updatePosSettings(s.sellerId, s.storeId, { taxRate: 0.2 } as any);

    const unknown: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, settingsVersion: 99, clientTotal: 120 }) as any, undefined);
    expect(unknown.data).toMatchObject({ tax: 20, settingsVersion: 2 });

    // version 1 was superseded 100h ago — beyond the 72h window → current rate
    await h.repos.posSettingsVersionModel.collection.updateOne({ storeId: s.storeId, version: 1 }, { $set: { supersededAt: new Date(Date.now() - 100 * HOUR) } });
    const tooOld: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, settingsVersion: 1, clientTotal: 120 }) as any, undefined);
    expect(tooOld.data).toMatchObject({ tax: 20, settingsVersion: 2 });

    // and inside the window it is honoured
    await h.repos.posSettingsVersionModel.collection.updateOne({ storeId: s.storeId, version: 1 }, { $set: { supersededAt: new Date(Date.now() - 10 * HOUR) } });
    const ok: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, settingsVersion: 1, clientTotal: 110 }) as any, undefined);
    expect(ok.data).toMatchObject({ tax: 10, settingsVersion: 1 });
  });

  it('a legacy settings document with no version gets version 1 history on first read and 2 on a tax change', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 5, taxRate: 0.05 });
    await h.repos.posSettingsModel.collection.updateOne({ storeId: s.storeId }, { $unset: { settingsVersion: '' } });
    expect(((await svc.getPosSettings(s.sellerId, s.storeId)) as any).data.settingsVersion).toBe(1);
    await h.repos.posSettingsModel.collection.updateOne({ storeId: s.storeId }, { $unset: { settingsVersion: '' } });
    await svc.updatePosSettings(s.sellerId, s.storeId, { taxRate: 0.07 } as any);
    expect(((await svc.getPosSettings(s.sellerId, s.storeId)) as any).data.settingsVersion).toBe(2);
    expect(await h.repos.posSettingsVersionModel.countDocuments({ storeId: s.storeId })).toBe(2);
  });

  it('a held sale completed with a version is priced with it', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 20, price: 100, taxRate: 0.1 });
    const sid = await open(svc, s);
    await svc.getPosSettings(s.sellerId, s.storeId);
    const held: any = await svc.createSale(s.sellerId, { ...offlineDto(s, sid, 0), offline: false, status: 'held' } as any, undefined);
    await svc.updatePosSettings(s.sellerId, s.storeId, { taxRate: 0.2 } as any);
    const done: any = await svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'cash', settingsVersion: 1 } as any, undefined);
    expect(done.data).toMatchObject({ tax: 10, settingsVersion: 1 });
  });
});

describe('quote (price a cart, no side effects)', () => {
  it('returns exactly what createSale then charges, and changes nothing', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 19.99, taxRate: 0.0825, baseCurrency: 'USD' });
    const sid = await open(svc, s);
    const items = [{ productId: s.productId, variantId: s.variantId, qty: 3 }];
    const q: any = await svc.quoteSale(s.sellerId, { storeId: s.storeId, items, discountType: 'percent', discountValue: 10 } as any);
    expect(q.data).toMatchObject({ subtotal: 59.97, discount: 6, tax: 4.45, total: 58.42, currency: 'USD', currencyExponent: 2, settingsVersion: 1, taxRate: 0.0825 });
    expect(q.data.lines[0]).toMatchObject({ qty: 3, price: 19.99, lineTotal: 59.97, sku: 'TEA-1' });
    expect(await h.repos.saleModel.countDocuments({})).toBe(0);
    expect(await stockOf(h, s.variantId)).toBe(10);
    const sale: any = await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.managerId, items, discountType: 'percent', discountValue: 10, paymentMethod: 'card', clientTotal: q.data.total, settingsVersion: q.data.settingsVersion } as any, mgrToken(s));
    expect(sale.data.total).toBe(q.data.total);
  });

  it('prices in the store currency exponent (JPY) and reports when a stale settingsVersion was replaced', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 333, baseCurrency: 'JPY', taxRate: 0.1 });
    const q: any = await svc.quoteSale(s.sellerId, { storeId: s.storeId, items: [{ productId: s.productId, variantId: s.variantId, qty: 3 }], settingsVersion: 42 } as any);
    expect(q.data).toMatchObject({ subtotal: 999, tax: 100, total: 1099, currency: 'JPY', currencyExponent: 0, settingsVersionReplaced: true });
  });

  it('rejects an empty cart and an unknown variant', async () => {
    const svc = makeService();
    const s = await seedStore(h);
    await expect(svc.quoteSale(s.sellerId, { storeId: s.storeId, items: [] } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.quoteSale(s.sellerId, { storeId: s.storeId, items: [{ productId: s.productId, variantId: new Types.ObjectId().toString(), qty: 1 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('manager review and offline discard', () => {
  async function flaggedSale(svc: PosService, s: Seed) {
    const sid = await open(svc, s, 5 * HOUR);
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { items: [{ productId: s.productId, variantId: s.variantId, qty: 5 }] }) as any, undefined);
    return String(res.data._id);
  }

  it('lists flagged sales; a manager resolves one with a note (audited); a second resolve is a business 409; a cashier cannot', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 1 });
    const id = await flaggedSale(svc, s);
    const list: any = await svc.getSalesNeedingReview(s.sellerId, s.storeId);
    expect(list.data.map((x: any) => String(x._id))).toEqual([id]);

    await expect(svc.resolveSaleReview(s.sellerId, id, 'checked the shelf', cashierToken(s))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await code(svc.resolveSaleReview(s.sellerId, id, 'x', mgrToken(s)))).toBe('REASON_REQUIRED');
    const done: any = await svc.resolveSaleReview(s.sellerId, id, 'recounted, stock corrected', mgrToken(s));
    expect(done.data).toMatchObject({ needsReview: false, reviewNote: 'recounted, stock corrected', reviewedBy: s.managerId });
    expect(await code(svc.resolveSaleReview(s.sellerId, id, 'again please', mgrToken(s)))).toBe('SALE_ALREADY_REVIEWED');
    expect(((await svc.getSalesNeedingReview(s.sellerId, s.storeId)) as any).count).toBe(0);
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'sale_review_resolved' })).toBe(1);
  });

  it('a discard needs a manager and a reason, writes the audit trail once (idempotent), and refuses a sale that already synced', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const dto = { storeId: s.storeId, idempotencyKey: 'never-synced-1', reason: 'customer left, sale void', summary: { total: 42, madeAt: 'yesterday' } };

    await expect(svc.recordOfflineDiscard(s.sellerId, dto, cashierToken(s))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await code(svc.recordOfflineDiscard(s.sellerId, { ...dto, reason: '' }, mgrToken(s)))).toBe('REASON_REQUIRED');

    const first: any = await svc.recordOfflineDiscard(s.sellerId, dto, mgrToken(s));
    const second: any = await svc.recordOfflineDiscard(s.sellerId, dto, mgrToken(s));
    expect(first.data.alreadyRecorded).toBe(false);
    expect(second.data.alreadyRecorded).toBe(true);
    const audit = await h.repos.posAuditLogModel.collection.find({ action: 'offline_sale_discarded' }).toArray();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetId: 'never-synced-1', employeeId: s.managerId });
    expect(audit[0].metadata).toMatchObject({ reason: 'customer left, sale void', summary: { total: 42 } });

    const sid = await open(svc, s, HOUR);
    await svc.createSale(s.sellerId, offlineDto(s, sid, 0, { offline: false, idempotencyKey: 'already-synced-1' }) as any, undefined);
    expect(await code(svc.recordOfflineDiscard(s.sellerId, { ...dto, idempotencyKey: 'already-synced-1' }, mgrToken(s)))).toBe('SALE_ALREADY_SYNCED');
  });
});

describe('5C.1: price charged offline is what is recorded (verified against price history)', () => {
  const setPrice = (s: Seed, price: number) => h.repos.productVariantModel.findOneAndUpdate({ _id: s.variantId }, { $set: { price } });

  it('a price change through Mongoose writes the OLD price to the history', async () => {
    const s = await seedStore(h, { stock: 10, price: 10 });
    await setPrice(s, 12);
    await setPrice(s, 15);
    await new Promise((r) => setTimeout(r, 200));
    const rows: any[] = await h.repos.variantPriceHistoryModel.find({ variantId: s.variantId }).sort({ price: 1 }).lean();
    expect(rows.map((r) => r.price)).toEqual([10, 12]);
  });

  it('charged == a price the variant had since the sale → recorded as charged, verified, drawer = collected', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    await setPrice(s, 12); // price rose after the sale was rung up at 10
    await new Promise((r) => setTimeout(r, 200));
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { items: [{ productId: s.productId, variantId: s.variantId, qty: 1, unitPrice: 10 }], clientTotal: 10, amountTendered: 10 }) as any, undefined);
    expect(res.data.total).toBe(10);
    expect(res.data.items[0]).toMatchObject({ price: 10, listPrice: 12, priceVerified: true });
    expect(res.data.flags).toEqual([]);
    expect(res.data.paymentShortfall).toBe(0);
    expect(await session(sid)).toMatchObject({ cashSales: 10, totalSales: 10 });
  });

  it('charged price never valid in the window → recorded anyway, flagged unverified_price, needs review, audited; drawer = collected', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { items: [{ productId: s.productId, variantId: s.variantId, qty: 2, unitPrice: 1 }], amountTendered: 2 }) as any, undefined);
    expect(res.data.total).toBe(2);
    expect(res.data.items[0]).toMatchObject({ price: 1, listPrice: 10, priceVerified: false });
    expect(res.data.needsReview).toBe(true);
    expect(res.data.flags.map((f: any) => f.type)).toEqual(['unverified_price']);
    expect(await session(sid)).toMatchObject({ cashSales: 2, totalSales: 2 });
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'sale_flag_unverified_price' })).toBe(1);
  });

  it('a price that was superseded BEFORE the sale was made is not accepted', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s, 5 * HOUR);
    await setPrice(s, 12);
    await new Promise((r) => setTimeout(r, 200));
    await h.repos.variantPriceHistoryModel.collection.updateMany({ variantId: s.variantId }, { $set: { supersededAt: new Date(Date.now() - 3 * HOUR) } });
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { items: [{ productId: s.productId, variantId: s.variantId, qty: 1, unitPrice: 10 }], amountTendered: 10 }) as any, undefined);
    expect(res.data.flags.map((f: any) => f.type)).toEqual(['unverified_price']);
  });

  it('unitPrice is ignored for an ONLINE sale (server price wins)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 10 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, { ...offlineDto(s, sid, 0), offline: false, items: [{ productId: s.productId, variantId: s.variantId, qty: 1, unitPrice: 1 }] } as any, undefined);
    expect(res.data.total).toBe(10);
  });
});

describe('5C.1: approving manager recorded on the sale', () => {
  // a PIN session that was already live when the sale (1h ago) was rung up
  const oldMgr = (s: Seed) => { const now = Math.floor(Date.now() / 1000); return mgrToken(s, { iat: now - 2 * 3600, exp: now + 10 * 3600 }); };
  it('stores approvedBy/approvedAt (sale time for offline)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    const sid = await open(svc, s, 5 * HOUR);
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { discountType: 'percent', discountValue: 10 }) as any, oldMgr(s));
    expect(res.data.approvedBy).toBe(s.managerId);
    expect(Math.abs(new Date(res.data.approvedAt).getTime() - (Date.now() - HOUR))).toBeLessThan(3000);
  });

  it('manager deactivated after the sale → sale still accepted, and the fact is logged', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    const sid = await open(svc, s, 5 * HOUR);
    const token = oldMgr(s);
    await h.repos.employeeModel.collection.updateOne({ _id: new Types.ObjectId(s.managerId) }, { $set: { status: 'inactive', isDelete: true } });
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, HOUR, { discountType: 'percent', discountValue: 10 }) as any, token);
    expect(res.data.status).toBe('completed');
    expect(res.data.approvedBy).toBe(s.managerId);
    await new Promise((r) => setTimeout(r, 100));
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'offline_approver_deactivated' })).toBe(1);
  });

  it('a sale with no discount has no approver', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    const sid = await open(svc, s);
    const res: any = await svc.createSale(s.sellerId, offlineDto(s, sid, 0) as any, undefined);
    expect(res.data.approvedBy).toBeNull();
  });
});
