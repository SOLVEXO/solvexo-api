/* eslint-disable prettier/prettier */
import { ObjectId } from 'mongodb';
import { EJSON } from 'bson';
import { Types } from 'mongoose';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';
import { StoreCreditTransactionSchema } from '../store-credit/schemas/store-credit-transaction.schema';
import { StoreCreditService } from '../store-credit/store-credit.service';
import { assertSafeTarget, MARK, migrateStoreCredit, migrateStoreCreditDown, SCM } from './store-credit-migrate.lib';

jest.setTimeout(240_000);
let h: MongoHarness; let r: any;
const db = () => h.conn.db!;
const mk = () => new StoreCreditService({ repositories: r } as any, { log: jest.fn() } as any, { notify: jest.fn().mockResolvedValue(undefined) } as any);
const snap = async () => { const o: Record<string, string> = {}; for (const c of await db().listCollections().toArray()) o[c.name] = EJSON.stringify(await db().collection(c.name).find({}).sort({ _id: 1 }).toArray()); return o; };
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const mode = (m: string) => { process.env.STORE_CREDIT_LEDGER = m; };

beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); r = h.repos; r.storeCreditTransactionModel = h.conn.model('StoreCreditTransaction', StoreCreditTransactionSchema); });
afterAll(async () => { delete process.env.STORE_CREDIT_LEDGER; await h?.stop(); });
beforeEach(async () => { for (const c of await db().listCollections().toArray()) await db().collection(c.name).deleteMany({}); delete process.env.STORE_CREDIT_LEDGER; });

/** a legacy ledger as production could hold it: float lots, a debit that consumed them, a depleted lot, an expired lot, an off-grid value, three currencies */
async function legacy() {
  const stores: Record<string, string> = {};
  for (const cur of ['USD', 'JPY', 'KWD']) { const id = new ObjectId(); stores[cur] = String(id); await db().collection('stores').insertOne({ _id: id, sellerId: 's', baseCurrency: cur, name: cur, slug: cur, isDelete: false, status: 'active' }); }
  const t0 = Date.now() - 20 * 86_400_000;
  const row = (over: any) => ({ _id: new ObjectId(), consumed: [], expiredHandled: false, remaining: 0, expiresAt: null, idemKey: null, orderId: null, checkoutId: null, note: '', actorId: 'a', actorRole: 'seller', createdAt: new Date(t0 + (over.seq ?? 0) * 3_600_000), updatedAt: new Date(t0), __v: 0, ...over });
  const lotA = row({ seq: 1, storeId: stores.USD, customerId: 'u1', currency: 'USD', type: 'issue', amount: 10, remaining: 4.5, balanceAfter: 10 });
  const lotB = row({ seq: 2, storeId: stores.USD, customerId: 'u1', currency: 'USD', type: 'adjust_credit', amount: 5, remaining: 5, expiresAt: days(7), balanceAfter: 15 });
  const spend = row({ seq: 3, storeId: stores.USD, customerId: 'u1', currency: 'USD', type: 'redeem', amount: -5.5, consumed: [{ lotId: String(lotA._id), amount: 5.5 }], balanceAfter: 9.5, idemKey: 'redeem:chk-1', orderId: 'o1', checkoutId: 'chk-1' });
  const depleted = row({ seq: 4, storeId: stores.USD, customerId: 'u2', currency: 'USD', type: 'refund_credit', amount: 3, remaining: 0, balanceAfter: 3, idemKey: 'rf-1' });
  const expired = row({ seq: 5, storeId: stores.USD, customerId: 'u2', currency: 'USD', type: 'issue', amount: 2, remaining: 0, expiredHandled: true, expiresAt: days(-2), balanceAfter: 0 });
  const expire = row({ seq: 6, storeId: stores.USD, customerId: 'u2', currency: 'USD', type: 'expire', amount: -2, balanceAfter: 0 });
  const yen = row({ seq: 7, storeId: stores.JPY, customerId: 'u3', currency: 'JPY', type: 'issue', amount: 1500, remaining: 1500, balanceAfter: 1500 });
  const dinar = row({ seq: 8, storeId: stores.KWD, customerId: 'u4', currency: 'KWD', type: 'issue', amount: 12.345, remaining: 12.345, balanceAfter: 12.345 });
  const offGrid = row({ seq: 9, storeId: stores.USD, customerId: 'u5', currency: 'USD', type: 'issue', amount: 1.239, remaining: 1.239, balanceAfter: 1.239 }); // 1.239 USD: the ledger said more than a cent can hold
  await db().collection(SCM.legacy).insertMany([lotA, lotB, spend, depleted, expired, expire, yen, dinar, offGrid]);
  return { stores, lotA, lotB };
}

describe('safety', () => {
  it('refuses a non-dev database without BOTH production flags', () => {
    expect(() => assertSafeTarget('solvexo_prod', {})).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { production: true, iHaveABackup: true })).not.toThrow();
  });
});

describe('migration: dry run, real run, idempotent, balances identical, reversible', () => {
  it('dry run writes nothing; up: every legacy row is an entry, every spendable lot a lot (with its expiry), the self-check passes; a second run writes 0', async () => {
    await legacy();
    const before = await snap();
    const dry = await migrateStoreCredit(db(), { dryRun: true });
    expect(await snap()).toEqual(before);
    expect([dry.legacyRows, dry.toMigrate, dry.entriesWritten, dry.lotsWritten]).toEqual([9, 9, 9, 5]); // spendable lots: lotA, lotB, yen, dinar, offGrid
    const up = await migrateStoreCredit(db(), { dryRun: false });
    expect(up.mismatches).toEqual([]);
    expect(up.offGrid.length).toBeGreaterThan(0); // the 1.239 row is reported (and rounded down)
    expect(await db().collection(SCM.entries).countDocuments({})).toBe(9);
    expect(await db().collection(SCM.legacy).countDocuments({ [MARK]: { $exists: true } })).toBe(9);
    const lots: any[] = await db().collection(SCM.lots).find({}).toArray();
    const by = (cur: string) => lots.filter((l) => l.currency === cur).map((l) => [Number(l.remainingMinor), l.currencyExponent, !!l.expiresAt]).sort();
    expect(by('JPY')).toEqual([[1500, 0, false]]);
    expect(by('KWD')).toEqual([[12345, 3, false]]);
    expect(by('USD')).toEqual([[123, 2, false], [450, 2, false], [500, 2, true]]); // 1.239 → 1.23 (rounded DOWN, never up); lotA 4.50; lotB 5.00 with its expiry
    const again = await migrateStoreCredit(db(), { dryRun: false });
    expect([again.toMigrate, again.entriesWritten, again.lotsWritten]).toEqual([0, 0, 0]);
  });

  it('a customer\'s balance and history are the same through the service before (legacy) and after (new); the legacy collection is never written by the new mode', async () => {
    const d = await legacy();
    mode('legacy');
    const old = mk();
    const oldBal = [await old.getSpendableBalance(d.stores.USD, 'u1'), await old.getSpendableBalance(d.stores.JPY, 'u3'), await old.getSpendableBalance(d.stores.KWD, 'u4')];
    const oldOv: any = await (old as any).overview(d.stores.USD, 'u1', { limit: 20 });
    await migrateStoreCredit(db(), { dryRun: false });
    const legacyBefore = await db().collection(SCM.legacy).find({}).sort({ _id: 1 }).toArray();
    mode('new');
    const nw = mk();
    // identical for USD and JPY; for KWD the legacy ledger ROUNDED to 2 decimals (12.345 read as 12.35) — the new ledger is exact (12.345)
    expect([await nw.getSpendableBalance(d.stores.USD, 'u1'), await nw.getSpendableBalance(d.stores.JPY, 'u3'), await nw.getSpendableBalance(d.stores.KWD, 'u4')]).toEqual([oldBal[0], oldBal[1], 12.345]);
    expect(oldBal[2]).toBe(12.35);
    const newOv: any = await (nw as any).overview(d.stores.USD, 'u1', { limit: 20 });
    expect(newOv.data.balance).toBe(oldOv.data.balance);
    expect(newOv.data.transactions.items.map((t: any) => [t.type, t.amount]).sort()).toEqual(oldOv.data.transactions.items.map((t: any) => [t.type, t.amount]).sort());
    expect(newOv.data.nextExpiry.amount).toBe(oldOv.data.nextExpiry.amount);
    // spending after the switch goes to the NEW ledger only (the legacy collection is frozen)
    expect(await nw.redeemAtOrderPlacement(d.stores.USD, 'u1', 4, 'chk-new', 'ord-new')).toBe(true);
    expect(await db().collection(SCM.legacy).find({}).sort({ _id: 1 }).toArray()).toEqual(legacyBefore);
    expect(await nw.getSpendableBalance(d.stores.USD, 'u1')).toBe(5.5);
  });

  it('dual spend is impossible at every step: legacy → (shadow rows exist) → migrating → new', async () => {
    const d = await legacy();
    // 1. legacy mode: the new collections are a shadow nobody reads — spending hits legacy only
    mode('legacy');
    await migrateStoreCredit(db(), { dryRun: false });
    expect(await mk().redeemAtOrderPlacement(d.stores.USD, 'u1', 9.5, 'chk-a', 'o-a')).toBe(true);
    // 2. migrating: nothing can be spent from either ledger
    mode('migrating');
    expect(await mk().getSpendableBalance(d.stores.USD, 'u1')).toBe(0);
    expect(await mk().redeemAtOrderPlacement(d.stores.USD, 'u1', 1, 'chk-b', 'o-b')).toBe(false);
    // 3. a migration run while migrating takes the CURRENT legacy state (the spend above is in it): re-do the shadow
    await migrateStoreCreditDown(db(), { dryRun: false });
    await migrateStoreCredit(db(), { dryRun: false });
    mode('new');
    expect(await mk().getSpendableBalance(d.stores.USD, 'u1')).toBe(0); // the 9.50 was spent while legacy was live; the fresh migration carried the true remainder
    expect(await mk().redeemAtOrderPlacement(d.stores.USD, 'u1', 1, 'chk-c', 'o-c')).toBe(false);
  });

  it('down removes exactly what up added (byte for byte) — and REFUSES once the new ledger has activity of its own, unless forced', async () => {
    await legacy();
    const before = await snap();
    await migrateStoreCredit(db(), { dryRun: false });
    expect(await snap()).not.toEqual(before);
    expect((await migrateStoreCreditDown(db(), { dryRun: true })).entries).toBe(9);
    await migrateStoreCreditDown(db(), { dryRun: false });
    expect(await snap()).toEqual(before);
    // after the switch someone spends: down must not silently lose that
    await migrateStoreCredit(db(), { dryRun: false });
    mode('new');
    const s = await db().collection('stores').findOne({ baseCurrency: 'USD' });
    await mk().adjust(String(s!._id), 'u1', { amount: 1 }, { actorId: 'a', actorRole: 'seller' });
    await expect(migrateStoreCreditDown(db(), { dryRun: false })).rejects.toThrow(/Refusing to remove the migration/);
    await migrateStoreCreditDown(db(), { dryRun: false, force: true });
    expect(await db().collection(SCM.legacy).countDocuments({ [MARK]: { $exists: true } })).toBe(0);
  });
});
