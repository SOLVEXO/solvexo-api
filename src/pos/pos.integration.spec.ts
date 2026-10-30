/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { from, lastValueFrom } from 'rxjs';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { IdempotencyInterceptor, IDEMPOTENCY_IN_PROGRESS } from '../common/idempotency.interceptor';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { AdminPosPlansService } from '../pos-plans/admin-pos-plans.service';
import { searchStoreCustomers } from '../common/store-customer-search.util';
import { findDuplicateOpenSessions, findStoresUsingPosWithoutPlan, grantStores } from '../scripts/pos-rollout.lib';
import { MongoHarness, oid, oidStr, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/**
 * REAL-MongoDB integration tests (mongodb-memory-server) for the guarantees the sale pipeline relies on the
 * database to keep: unique idempotency key, atomic floor-guarded stock, status-guarded claims, the unique
 * open-session index. Mocks can't prove any of these — only a real server racing real concurrent requests can.
 */
jest.setTimeout(120_000);

let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
const makeService = () => new PosService({ repositories: h.repos } as any, activityLog as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);

const managerToken = (s: { storeId: string; managerId: string }) =>
  jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });

async function openSession(svc: PosService, s: Awaited<ReturnType<typeof seedStore>>) {
  const res: any = await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 0 } as any);
  return String(res.data._id);
}

const saleDto = (s: any, sessionId: string, over: any = {}) => ({
  storeId: s.storeId, sessionId, registerId: s.registerId, employeeId: s.cashierId,
  items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], paymentMethod: 'cash', ...over,
});

/** Runs `fn` as the handler behind a real IdempotencyInterceptor, exactly as the controller routes do. */
function viaInterceptor(key: string | undefined, userId: string, fn: () => Promise<any>, route = '/api/pos/sales') {
  const interceptor = new IdempotencyInterceptor({ repositories: h.repos } as any);
  const ctx: any = { switchToHttp: () => ({ getRequest: () => ({ headers: key ? { 'idempotency-key': key } : {}, user: { userId }, method: 'POST', route: { path: route }, url: route }) }) };
  return lastValueFrom(interceptor.intercept(ctx, { handle: () => from(fn()) }));
}

/** Polls until `cond()` is true (the interceptor persists its result fire-and-forget, so tests must not use fixed sleeps). */
async function waitFor(cond: () => Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
}
const idemStatus = async (key: string) => ((await h.repos.idempotencyRecordModel.collection.findOne({ key: { $regex: `:${key}$` } })) as any)?.status;

const salesCount = (storeId: string) => h.repos.saleModel.countDocuments({ storeId });

describe('idempotent createSale (real Mongo)', () => {
  it('the same Idempotency-Key sent concurrently → exactly ONE sale and ONE stock decrement', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => viaInterceptor('key-A', s.sellerId, () => svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'key-A' }) as any, undefined))),
    );

    expect(await salesCount(s.storeId)).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(8); // 10 − 2, taken once
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
      expect(r.reason).toBeInstanceOf(ConflictException);
      expect(r.reason.getResponse()).toMatchObject({ code: IDEMPOTENCY_IN_PROGRESS }); // only ever the retryable "still running" 409
    }
    const ids = new Set(ok.map((r) => String(r.value.data._id)));
    expect(ids.size).toBe(1);
  });

  it('the same body idempotencyKey concurrently WITHOUT the header (unique index path) → one sale, one decrement, same sale returned', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);

    const results: any[] = await Promise.all(
      Array.from({ length: 6 }, () => svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'key-B' }) as any, undefined)),
    );

    expect(await salesCount(s.storeId)).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(8);
    expect(new Set(results.map((r) => String(r.data._id))).size).toBe(1);
  });

  it('a concurrent duplicate that finds the stock already taken by its twin gets the sale, not "insufficient stock"', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 2 }); // exactly enough for ONE sale of qty 2
    const sessionId = await openSession(svc, s);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'key-tight' }) as any, undefined)),
    );
    expect(await salesCount(s.storeId)).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(0);
    // every duplicate either returned the winner or was told to retry later — never a spurious second sale
    for (const r of results) if (r.status === 'fulfilled') expect((r.value as any).data.idempotencyKey).toBe('key-tight');
  });

  it('replay after success returns the ORIGINAL stored result, not an error', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const call = () => viaInterceptor('key-C', s.sellerId, () => svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'key-C' }) as any, undefined));

    const first = await call();
    await waitFor(async () => (await idemStatus('key-C')) === 'completed'); // interceptor persists the result fire-and-forget
    const replay = await call();

    expect(replay).toEqual(JSON.parse(JSON.stringify(first))); // byte-identical original result (message included)
    expect(replay.message).toBe('Sale completed');
    expect(await salesCount(s.storeId)).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(8);
  });

  it('"still in progress" is a DISTINCT machine-readable 409, and the key works again once the first request finishes', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = viaInterceptor('key-D', s.sellerId, async () => { await gate; return svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'key-D' }) as any, undefined); });

    await waitFor(async () => (await idemStatus('key-D')) === 'in_progress'); // first request has claimed the key and is running
    const second = viaInterceptor('key-D', s.sellerId, () => Promise.resolve({ shouldNeverRun: true }));
    await expect(second).rejects.toMatchObject({ response: { code: IDEMPOTENCY_IN_PROGRESS, statusCode: 409 } });

    release();
    const firstResult = await slow;
    await waitFor(async () => (await idemStatus('key-D')) === 'completed');
    const third = await viaInterceptor('key-D', s.sellerId, () => Promise.resolve({ shouldNeverRun: true }));
    expect(third).toEqual(JSON.parse(JSON.stringify(firstResult)));
  });

  it('a crashed request\'s stale claim is taken over instead of locking the client out', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    // simulate a request that claimed the key and then died 5 minutes ago
    await h.repos.idempotencyRecordModel.collection.insertOne({
      key: `${s.sellerId}:POST:/api/pos/sales:key-E`, requesterId: s.sellerId, route: '/api/pos/sales', status: 'in_progress',
      expiresAt: new Date(Date.now() + 3600_000), createdAt: new Date(Date.now() - 300_000), updatedAt: new Date(Date.now() - 300_000),
    });
    const res = await viaInterceptor('key-E', s.sellerId, () => svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'key-E' }) as any, undefined));
    expect(res.data.status).toBe('completed');
  });

  it('key-less sales still work, repeatedly (Phase-4 sparse-index regression) and store no idempotencyKey field', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);

    await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    await svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: 'k1' }) as any, undefined);
    await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);

    expect(await salesCount(s.storeId)).toBe(4);
    const raw = await h.repos.saleModel.collection.find({ idempotencyKey: { $exists: false } }).toArray();
    expect(raw.length).toBe(3); // the field is genuinely absent, not null — what keeps the sparse unique index happy
    expect(await stockOf(h, s.variantId)).toBe(2); // 10 − 4×2
  });

  it('never oversells: concurrent DIFFERENT sales cannot take more stock than exists', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 5 });
    const sessionId = await openSession(svc, s);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => svc.createSale(s.sellerId, saleDto(s, sessionId, { idempotencyKey: `race-${i}`, items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }] }) as any, undefined)),
    );
    const sold = results.filter((r) => r.status === 'fulfilled').length;
    expect(sold).toBe(2); // 5 units / 2 per sale
    expect(await stockOf(h, s.variantId)).toBe(1);
    expect(await salesCount(s.storeId)).toBe(2);
    for (const r of results) if (r.status === 'rejected') expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestException);
  });
});

describe('sessions (real Mongo)', () => {
  it('only ONE of many concurrent openSession calls on one register succeeds (unique partial index)', async () => {
    const svc = makeService();
    const s = await seedStore(h);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 0 } as any)),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results) if (r.status === 'rejected') expect((r as PromiseRejectedResult).reason.message).toMatch(/already has an open session/);
    expect(await h.repos.registerSessionModel.countDocuments({ registerId: s.registerId, status: 'open' })).toBe(1);
  });

  it('closed sessions don\'t block a new open (the index is partial)', async () => {
    const svc = makeService();
    const s = await seedStore(h);
    const id = await openSession(svc, s);
    await svc.closeSession(s.sellerId, { sessionId: id, closingCash: 0 } as any);
    await expect(openSession(svc, s)).resolves.toBeDefined();
  });

  it('closing twice concurrently → one succeeds, the other gets the business code SESSION_ALREADY_CLOSED', async () => {
    const svc = makeService();
    const s = await seedStore(h);
    const id = await openSession(svc, s);
    const results = await Promise.allSettled([1, 2, 3].map(() => svc.closeSession(s.sellerId, { sessionId: id, closingCash: 0 } as any)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results) if (r.status === 'rejected') {
      const e = (r as PromiseRejectedResult).reason;
      // either the findOne saw it closed already (404) or the atomic claim lost (409 business code)
      expect([404, 409]).toContain(e.getStatus());
      if (e.getStatus() === 409) expect(e.getResponse()).toMatchObject({ code: 'SESSION_ALREADY_CLOSED' });
    }
  });
});

describe('held sales (real Mongo)', () => {
  it('two terminals completing the same held sale at once → ONE success, ONE business 409; stock and session counted once', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const held: any = await svc.createSale(s.sellerId, saleDto(s, sessionId, { status: 'held' }) as any, undefined);
    expect(await stockOf(h, s.variantId)).toBe(10); // holding takes no stock
    const saleId = String(held.data._id);

    const results = await Promise.allSettled(
      [1, 2, 3].map(() => svc.completeSale(s.sellerId, saleId, { paymentMethod: 'cash' } as any, undefined)),
    );

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    for (const r of results) if (r.status === 'rejected') {
      const e = (r as PromiseRejectedResult).reason;
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({ code: 'HELD_SALE_ALREADY_RESOLVED', statusCode: 409 });
    }
    expect(await stockOf(h, s.variantId)).toBe(8);
    const session: any = await h.repos.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(sessionId) });
    expect(session.totalTransactions).toBe(1);
  });

  it('discard racing completion cannot delete a sale that just became real', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const held: any = await svc.createSale(s.sellerId, saleDto(s, sessionId, { status: 'held' }) as any, undefined);
    const saleId = String(held.data._id);
    await Promise.allSettled([
      svc.completeSale(s.sellerId, saleId, { paymentMethod: 'cash' } as any, undefined),
      svc.discardHeldSale(s.sellerId, saleId),
    ]);
    const sale: any = await h.repos.saleModel.collection.findOne({ _id: new Types.ObjectId(saleId) });
    const stock = await stockOf(h, s.variantId);
    // consistent either way: completed sale + stock taken, OR discarded sale + stock untouched — never a mix
    if (sale) { expect(sale.status).toBe('completed'); expect(stock).toBe(8); } else { expect(stock).toBe(10); }
  });
});

describe('refund / void stock handling (real Mongo)', () => {
  it('refund and void on an UNLIMITED variant leave stock exactly untouched', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 5, unlimited: true });
    const sessionId = await openSession(svc, s);
    const token = managerToken(s);

    const a: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const b: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    expect(await stockOf(h, s.variantId)).toBe(5); // selling never took stock

    await svc.refundSale(s.sellerId, String(a.data._id), undefined, token);
    expect(await stockOf(h, s.variantId)).toBe(5);
    await svc.voidSale(s.sellerId, String(b.data._id), {}, token);
    expect(await stockOf(h, s.variantId)).toBe(5);
  });

  it('partial refund on an unlimited variant leaves stock untouched too', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 5, unlimited: true });
    const sessionId = await openSession(svc, s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const item = a.data.items[0];
    await svc.refundSale(s.sellerId, String(a.data._id), { items: [{ saleItemId: String(item._id), qty: 1 }] } as any, managerToken(s));
    expect(await stockOf(h, s.variantId)).toBe(5);
  });

  it('a TRACKED variant gets its stock back exactly once on refund and on void', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const token = managerToken(s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const b: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    expect(await stockOf(h, s.variantId)).toBe(6);
    await svc.refundSale(s.sellerId, String(a.data._id), undefined, token);
    expect(await stockOf(h, s.variantId)).toBe(8);
    await svc.voidSale(s.sellerId, String(b.data._id), {}, token);
    expect(await stockOf(h, s.variantId)).toBe(10);
  });

  it('concurrent double refund → one wins, the other is rejected, stock restored ONCE', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const token = managerToken(s);

    const results = await Promise.allSettled([1, 2, 3, 4].map(() => svc.refundSale(s.sellerId, String(a.data._id), undefined, token)));

    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(10); // 8 + 2 once, not 8 + 2×N
    for (const r of results) if (r.status === 'rejected') {
      const e = (r as PromiseRejectedResult).reason;
      expect([ConflictException, BadRequestException].some((c) => e instanceof c)).toBe(true);
    }
  });

  it('concurrent void vs refund → exactly one applies', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const token = managerToken(s);
    const results = await Promise.allSettled([
      svc.refundSale(s.sellerId, String(a.data._id), undefined, token),
      svc.voidSale(s.sellerId, String(a.data._id), {}, token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    expect(await stockOf(h, s.variantId)).toBe(10);
  });

  it('a cashier token cannot refund (role still enforced against the real DB path)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10 });
    const sessionId = await openSession(svc, s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const cashier = jwt.sign({ employeeId: s.cashierId, storeId: s.storeId, role: 'cashier', type: 'pos_employee' }, 'test-secret');
    await expect(svc.refundSale(s.sellerId, String(a.data._id), undefined, cashier)).rejects.toBeInstanceOf(ForbiddenException);
    expect(await stockOf(h, s.variantId)).toBe(8);
  });
});

describe('store-scoped customer search (real Mongo)', () => {
  it('finds only people who relate to THIS store (order buyers, POS customers, seller-tagged) — never other stores\' buyers', async () => {
    const r = h.repos;
    const storeA = oidStr(); const storeB = oidStr();
    const [uOrder, uPos, uMeta, uOther, uNobody] = [oid(), oid(), oid(), oid(), oid()];
    await r.userModel.collection.insertMany([
      { _id: uOrder, name: 'Alice Smith', email: 'alice@x.com', phone: '111' },
      { _id: uPos, name: 'Bob Smith', email: 'bob@x.com', phone: '222' },
      { _id: uMeta, name: 'Carol Smith', email: 'carol@x.com', phone: '333' },
      { _id: uOther, name: 'Dave Smith', email: 'dave@x.com', phone: '444' },
      { _id: uNobody, name: 'Erin Smith', email: 'erin@x.com', phone: '555' },
    ]);
    await r.orderModel.collection.insertMany([
      { orderNumber: 'ORD-A', sellerOrders: [{ storeId: storeA }], customerId: String(uOrder), isDelete: false },
      { orderNumber: 'ORD-B', sellerOrders: [{ storeId: storeB }], customerId: String(uOther), isDelete: false },
    ]);
    await r.saleModel.collection.insertOne({ storeId: storeA, customerId: String(uPos), saleNumber: 'POS-1' });
    await r.storeCustomerMetaModel.collection.insertOne({ storeId: storeA, userId: String(uMeta) });

    const forA = await searchStoreCustomers(r as any, storeA, 'smith');
    expect(forA.map((u) => u.name).sort()).toEqual(['Alice Smith', 'Bob Smith', 'Carol Smith']);
    const forB = await searchStoreCustomers(r as any, storeB, 'smith');
    expect(forB.map((u) => u.name)).toEqual(['Dave Smith']);
    expect(await searchStoreCustomers(r as any, oidStr(), 'smith')).toEqual([]); // a store with no customers sees nobody
    expect(forA[0]).toEqual(expect.objectContaining({ id: expect.any(String), email: expect.any(String), phone: expect.any(String) })); // response shape unchanged
  });

  it('a regex-looking query is treated literally (no injection)', async () => {
    const r = h.repos;
    const storeA = oidStr(); const u = oid();
    await r.userModel.collection.insertOne({ _id: u, name: 'Alice', email: 'a@x.com', phone: '1' });
    await r.orderModel.collection.insertOne({ orderNumber: 'ORD-X', sellerOrders: [{ storeId: storeA }], customerId: String(u), isDelete: false });
    expect(await searchStoreCustomers(r as any, storeA, '.*')).toEqual([]);
  });
});

describe('entitlement guard + manual admin grants (real Mongo)', () => {
  const ORIGINAL = process.env.POS_ENTITLEMENT_ENFORCED;
  beforeEach(() => { process.env.POS_ENTITLEMENT_ENFORCED = 'true'; });
  afterAll(() => { if (ORIGINAL === undefined) delete process.env.POS_ENTITLEMENT_ENFORCED; else process.env.POS_ENTITLEMENT_ENFORCED = ORIGINAL; });

  const admin = { adminId: 'admin-1', email: 'admin@solvexo.com' };
  const adminSvc = () => new AdminPosPlansService({ repositories: h.repos } as any, activityLog as any);
  const guard = () => new PosEntitlementGuard({ repositories: h.repos } as any);
  const ctx = (storeId: string) => ({ switchToHttp: () => ({ getRequest: () => ({ params: { storeId }, method: 'POST', route: { path: '/x' } }) }) }) as any;

  beforeEach(() => activityLog.log.mockClear());

  it('grant → guard allows; extend adds days to the current expiry; revoke → guard blocks again', async () => {
    const s = await seedStore(h);
    await expect(guard().canActivate(ctx(s.storeId))).rejects.toMatchObject({ response: { code: 'POS_PLAN_REQUIRED' } });

    const granted: any = await adminSvc().grantManually({ storeId: s.storeId, days: 30, reason: 'pilot customer' } as any, admin);
    await expect(guard().canActivate(ctx(s.storeId))).resolves.toBe(true);
    expect(granted.data.source).toBe('manual');
    expect(granted.data.grantedByAdminId).toBe('admin-1');

    const before = new Date(granted.data.expiresAt).getTime();
    const extended: any = await adminSvc().extendManually({ storeId: s.storeId, days: 10, reason: 'goodwill' } as any, admin);
    expect(new Date(extended.data.expiresAt).getTime()).toBeCloseTo(before + 10 * 86_400_000, -3); // from the current expiry, not from now

    await adminSvc().revokeManually({ storeId: s.storeId, reason: 'chargeback' } as any, admin);
    await expect(guard().canActivate(ctx(s.storeId))).rejects.toMatchObject({ response: { code: 'POS_PLAN_REQUIRED' } });
  });

  it('every manual action writes an audit-log entry with the admin id and the reason', async () => {
    const s = await seedStore(h);
    await adminSvc().grantManually({ storeId: s.storeId, days: 5, reason: 'support ticket 42' } as any, admin);
    await adminSvc().extendManually({ storeId: s.storeId, days: 5, reason: 'still evaluating' } as any, admin);
    await adminSvc().revokeManually({ storeId: s.storeId, reason: 'abuse' } as any, admin);

    const calls = activityLog.log.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.action)).toEqual(['pos_plan_granted', 'pos_plan_extended', 'pos_plan_revoked']);
    for (const c of calls) {
      expect(c).toMatchObject({ category: 'admin_audit', actorId: 'admin-1', actorRole: 'admin', targetId: s.storeId, targetType: 'store' });
      expect(c.metadata.adminId).toBe('admin-1');
      expect(typeof c.metadata.reason).toBe('string');
    }
    expect(calls[0].metadata.reason).toBe('support ticket 42');
  });

  it('grant refuses a store that already has an active plan; revoke refuses a store with none', async () => {
    const s = await seedStore(h);
    await expect(adminSvc().revokeManually({ storeId: s.storeId, reason: 'nothing to revoke' } as any, admin)).rejects.toBeInstanceOf(BadRequestException);
    await adminSvc().grantManually({ storeId: s.storeId, days: 5, reason: 'first grant' } as any, admin);
    await expect(adminSvc().grantManually({ storeId: s.storeId, days: 5, reason: 'second grant' } as any, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a suspended store is blocked even with a plan', async () => {
    const s = await seedStore(h);
    await adminSvc().grantManually({ storeId: s.storeId, days: 5, reason: 'x test' } as any, admin);
    await h.repos.storeModel.collection.updateOne({ _id: new Types.ObjectId(s.storeId) }, { $set: { status: 'suspended' } });
    await expect(guard().canActivate(ctx(s.storeId))).rejects.toMatchObject({ response: { code: 'POS_STORE_DISABLED' } });
  });

  it('the guard resolves the store from a sale id / session id against the real DB', async () => {
    const svc = makeService();
    const s = await seedStore(h);
    await adminSvc().grantManually({ storeId: s.storeId, days: 5, reason: 'x test' } as any, admin);
    const sessionId = await openSession(svc, s);
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sessionId) as any, undefined);
    const byParams = (params: any) => ({ switchToHttp: () => ({ getRequest: () => ({ params, method: 'POST' }) }) }) as any;
    await expect(guard().canActivate(byParams({ sessionId }))).resolves.toBe(true);
    await expect(guard().canActivate(byParams({ saleId: String(sale.data._id) }))).resolves.toBe(true);
  });
});

describe('rollout scripts (real Mongo)', () => {
  it('lists stores that used POS without an active plan, and --grant is idempotent and insert-only', async () => {
    const svc = makeService();
    const r = h.repos;
    const a = await seedStore(h); const b = await seedStore(h); const c = await seedStore(h); const d = await seedStore(h);
    await openSession(svc, a);                                  // used POS, never bought a plan
    await r.saleModel.collection.insertOne({ storeId: b.storeId, saleNumber: 'POS-1', createdAt: new Date() }); // used POS, active plan
    await openSession(svc, c);                                  // used POS, plan expired
    // d never used POS
    const day = 86_400_000;
    await r.posPurchaseModel.collection.insertOne({ storeId: b.storeId, sellerId: b.sellerId, planId: 'p', planNameSnapshot: 'Pro', priceSnapshot: 10, currencySnapshot: 'USD', durationInDaysSnapshot: 30, stripeCheckoutSessionId: 'cs_1', purchasedAt: new Date(), expiresAt: new Date(Date.now() + 10 * day) });
    await r.posPurchaseModel.collection.insertOne({ storeId: c.storeId, sellerId: c.sellerId, planId: 'p', planNameSnapshot: 'Pro', priceSnapshot: 10, currencySnapshot: 'USD', durationInDaysSnapshot: 30, stripeCheckoutSessionId: 'cs_2', purchasedAt: new Date(Date.now() - 40 * day), expiresAt: new Date(Date.now() - 10 * day) });

    const db = h.conn.db!;
    const listed = await findStoresUsingPosWithoutPlan(db);
    expect(listed.map((s) => s.storeId).sort()).toEqual([a.storeId, c.storeId].sort());
    expect(listed.find((s) => s.storeId === a.storeId)!.planState).toBe('none');
    expect(listed.find((s) => s.storeId === c.storeId)!.planState).toBe('expired');

    // dry run == just the listing: nothing written
    expect(await r.posPurchaseModel.countDocuments({ source: 'manual' })).toBe(0);

    const res = await grantStores(db, listed, { days: 30, reason: 'migration', actorId: 'script:pos-plan-backfill' });
    expect(res.granted.sort()).toEqual([a.storeId, c.storeId].sort());
    expect(await r.posPurchaseModel.countDocuments({ source: 'manual' })).toBe(2);
    expect(await db.collection('activitylogs').countDocuments({ action: 'pos_plan_granted' })).toBe(2);

    // idempotent: re-listing finds nobody; re-granting the OLD list skips everyone and writes nothing
    expect(await findStoresUsingPosWithoutPlan(db)).toEqual([]);
    const again = await grantStores(db, listed, { days: 30, reason: 'migration', actorId: 'script:pos-plan-backfill' });
    expect(again.granted).toEqual([]);
    expect(again.skipped.length).toBe(2);
    expect(await r.posPurchaseModel.countDocuments({ source: 'manual' })).toBe(2);
    // existing purchases were not edited
    expect((await r.posPurchaseModel.collection.findOne({ stripeCheckoutSessionId: 'cs_2' }) as any).expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it('pre-flight finds registers with more than one open session (before the unique index exists)', async () => {
    const db = h.conn.getClient().db('preflight_no_index'); // a database where the unique index was never built
    const reg1 = oidStr(); const reg2 = oidStr();
    await db.collection('registersessions').insertMany([
      { storeId: 's1', registerId: reg1, employeeId: 'e1', status: 'open', openedAt: new Date(1), totalSales: 10, cashSales: 5 },
      { storeId: 's1', registerId: reg1, employeeId: 'e2', status: 'open', openedAt: new Date(2), totalSales: 0, cashSales: 0 },
      { storeId: 's1', registerId: reg2, employeeId: 'e1', status: 'open', openedAt: new Date(3) },
      { storeId: 's1', registerId: reg2, employeeId: 'e1', status: 'closed', openedAt: new Date(0) },
    ]);
    const dupes = await findDuplicateOpenSessions(db);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].registerId).toBe(reg1);
    expect(dupes[0].openSessions.map((x) => x.employeeId)).toEqual(['e1', 'e2']);
    // and the real index makes duplicates impossible going forward
    const real = h.conn.db!.collection('registersessions');
    await real.insertOne({ storeId: 's1', registerId: reg1, status: 'open' });
    await expect(real.insertOne({ storeId: 's1', registerId: reg1, status: 'open' })).rejects.toMatchObject({ code: 11000 });
  });
});
