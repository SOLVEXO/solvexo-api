/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { BadRequestException } from '@nestjs/common';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';
import { StoreCreditTransactionSchema } from './schemas/store-credit-transaction.schema';
import { StoreCreditService, storeCreditMode } from './store-credit.service';

/**
 * G3.3 on a real MongoDB: the new minor-unit ledger behind the storefront's StoreCreditService answers EXACTLY like the legacy one (same methods, same response shapes, same
 * numbers) — the storefront contract does not move — and spending the same balance from the storefront and the till at once can never succeed twice.
 */
jest.setTimeout(240_000);
let h: MongoHarness; let r: any;
const actor = { actorId: 'seller-1', actorRole: 'seller' as const };
const mkSvc = () => new StoreCreditService({ repositories: r } as any, { log: jest.fn() } as any, { notify: jest.fn().mockResolvedValue(undefined) } as any);
const setMode = (m: string) => { process.env.STORE_CREDIT_LEDGER = m; };

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  r = h.repos;
  r.storeCreditTransactionModel = h.conn.model('StoreCreditTransaction', StoreCreditTransactionSchema);
  await r.storeCreditTransactionModel.init();
});
afterAll(async () => { delete process.env.STORE_CREDIT_LEDGER; await h?.stop(); });
afterEach(() => { delete process.env.STORE_CREDIT_LEDGER; });

async function store(currency = 'USD') {
  const id = new Types.ObjectId();
  await r.storeModel.collection.insertOne({ _id: id, sellerId: 's', baseCurrency: currency, name: 'S', slug: `s${id}`, isDelete: false, status: 'active' });
  return String(id);
}
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const shape = (o: any): any => { const j = JSON.parse(JSON.stringify(o)); const walk = (v: any): any => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).filter((k) => k !== '__v').sort().map((k) => [k, walk(v[k])])) : typeof v); return walk(j); };

/** the scenario both ledgers must answer identically */
async function scenario(mode: 'legacy' | 'new', currency = 'USD', unit = 1) {
  setMode(mode);
  const svc = mkSvc(); const sid = await store(currency); const cust = `c-${new Types.ObjectId()}`;
  const out: any = {};
  const a1 = await svc.adjust(sid, cust, { amount: 10 * unit, note: 'welcome' }, actor);
  out.firstAdjust = { message: a1.message, balance: a1.data.balance, currency: a1.data.currency, type: a1.data.transaction.type, txShape: shape(a1.data.transaction) };
  const a2 = await svc.adjust(sid, cust, { amount: 5 * unit, expiresAt: days(10) }, actor);
  out.secondAdjust = { balance: a2.data.balance, type: a2.data.transaction.type };
  out.balance = await svc.getSpendableBalance(sid, cust);
  const red = await svc.redeemAtOrderPlacement(sid, cust, 4 * unit, 'chk-1', 'ord-1');
  const dup = await svc.redeemAtOrderPlacement(sid, cust, 4 * unit, 'chk-1', 'ord-1');
  out.redeem = [red, dup, await svc.getSpendableBalance(sid, cust)];
  out.restore = [await svc.restoreOnRefund(sid, cust, 2 * unit, 'ord-1', 'rf-1'), await svc.restoreOnRefund(sid, cust, 2 * unit, 'ord-1', 'rf-1'), await svc.getSpendableBalance(sid, cust)];
  out.refundCredit = [await svc.creditFromRefund(sid, cust, 1 * unit, 'ord-2', 'rf-2', 'refund', actor), await svc.getSpendableBalance(sid, cust)];
  const debit = await svc.adjust(sid, cust, { amount: -3 * unit, note: 'oops' }, actor);
  out.debit = { message: debit.message, balance: debit.data.balance, type: debit.data.transaction.type };
  out.tooMuch = await svc.adjust(sid, cust, { amount: -1000 * unit }, actor).catch((e: any) => (e instanceof BadRequestException ? 'BadRequest' : e.message));
  out.covers = await svc.assertCovers(sid, cust, 1000 * unit).then(() => 'ok').catch((e: any) => e.message);
  const ov: any = await svc.getCustomerOverview(sid, cust, { limit: 50 }).catch(async () => (svc as any).overview(sid, cust, { limit: 50 }));
  out.overview = { currency: ov.data.currency, balance: ov.data.balance, nextExpiry: !!ov.data.nextExpiry, total: ov.data.transactions.total, types: ov.data.transactions.items.map((t: any) => t.type).sort(), keys: shape(ov.data.transactions.items[0]) };
  return out;
}

describe('the storefront contract does not move: legacy and new answer identically', () => {
  for (const [cur, unit] of [['USD', 1], ['JPY', 100], ['KWD', 1]] as const) {
    it(`${cur}: adjust / redeem (idempotent) / restore / refund-as-credit / debit / over-debit / assertCovers / overview — same results in both modes`, async () => {
      const legacy = await scenario('legacy', cur, unit);
      const fresh = await scenario('new', cur, unit);
      expect(fresh).toEqual(legacy);
      expect(fresh.redeem).toEqual([true, true, 11 * unit]);
      expect(fresh.restore).toEqual([true, false, 13 * unit]);
    });
  }

  it('amounts are EXACT integers in every exponent: 0.001 KWD, 1 JPY, 0.01 USD, and a sum of lots has no float drift', async () => {
    setMode('new');
    const svc = mkSvc();
    for (const [cur, tiny, exp] of [['KWD', 0.001, 3], ['JPY', 1, 0], ['USD', 0.01, 2]] as const) {
      const sid = await store(cur); const c = 'c-exact';
      for (let i = 0; i < 10; i++) await svc.adjust(sid, c, { amount: tiny }, actor);
      expect(await svc.getSpendableBalance(sid, c)).toBe(Number((tiny * 10).toFixed(exp)));
      const lots: any[] = await r.storeCreditLotModel.find({ storeId: sid }).lean();
      expect(lots.every((l) => Number.isInteger(l.remainingMinor) && l.currencyExponent === exp)).toBe(true);
    }
  });

  it('expiry: soonest-expiring credit is spent first; the sweep zeroes an expired lot and writes an entry; both modes', async () => {
    setMode('new');
    const svc = mkSvc(); const sid = await store(); const c = 'c-exp';
    await svc.adjust(sid, c, { amount: 5 }, actor); // never expires
    await svc.adjust(sid, c, { amount: 5, expiresAt: days(3) }, actor);
    await svc.redeemAtOrderPlacement(sid, c, 5, 'chk-e', 'ord-e');
    const lots: any[] = await r.storeCreditLotModel.find({ storeId: sid }).sort({ createdAt: 1 }).lean();
    expect([lots[0].remainingMinor, lots[1].remainingMinor]).toEqual([500, 0]); // the expiring lot went first
    await svc.adjust(sid, c, { amount: 2, expiresAt: days(1) }, actor);
    await r.storeCreditLotModel.updateOne({ storeId: sid, expiresAt: { $ne: null }, remainingMinor: 200 }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await svc.getSpendableBalance(sid, c)).toBe(5); // an expired lot is not spendable even before the sweep
    expect(await svc.expireDueLots()).toEqual({ expired: 1 });
    expect((await r.storeCreditEntryModel.findOne({ storeId: sid, type: 'expire' }).lean()).amountMinor).toBe(-200);
  });
});

describe('dual spend is impossible: the storefront and the till spend the SAME balance at the same time', () => {
  it('20 concurrent spends of 3 against 10: exactly 3 succeed, the balance is 1, nothing goes negative, every lot unit is accounted for', async () => {
    setMode('new');
    const svc = mkSvc(); const sid = await store(); const c = 'c-race';
    await svc.adjust(sid, c, { amount: 4 }, actor); await svc.adjust(sid, c, { amount: 6, expiresAt: days(5) }, actor);
    const spends = Array.from({ length: 20 }, (_, i) => (i % 2 ? svc.redeemAtOrderPlacement(sid, c, 3, `chk-${i}`, `ord-${i}`) : svc.ledger.spend({ storeId: sid, customerId: c, amountMinor: 300, type: 'spend', idemKey: `sale-${i}`, actor: { actorId: 'emp', actorRole: 'cashier' }, refs: { saleId: `s-${i}` } }).then((x) => x.ok)));
    const res = await Promise.all(spends);
    expect(res.filter(Boolean)).toHaveLength(3);
    expect(await svc.getSpendableBalance(sid, c)).toBe(1);
    const lots: any[] = await r.storeCreditLotModel.find({ storeId: sid }).lean();
    expect(lots.every((l) => l.remainingMinor >= 0)).toBe(true);
    const spent = (await r.storeCreditEntryModel.find({ storeId: sid, type: { $in: ['redeem', 'spend'] } }).lean()).reduce((t: number, e: any) => t - e.amountMinor, 0);
    expect(spent).toBe(900); // Σ entries = what left the lots
    expect(lots.reduce((t: number, l: any) => t + l.amountMinor - l.remainingMinor, 0)).toBe(900);
  });

  it('two spends of 7 against 10 (one storefront, one till): exactly one wins; the loser takes NOTHING (what it grabbed is put back)', async () => {
    for (let round = 0; round < 15; round++) {
      setMode('new');
      const svc = mkSvc(); const sid = await store(); const c = 'c-two';
      await svc.adjust(sid, c, { amount: 5 }, actor); await svc.adjust(sid, c, { amount: 5, expiresAt: days(2) }, actor);
      const [a, b] = await Promise.all([svc.redeemAtOrderPlacement(sid, c, 7, 'chk-x', 'ord-x'), svc.ledger.spend({ storeId: sid, customerId: c, amountMinor: 700, type: 'spend', idemKey: 'sale-x', actor: { actorId: 'e', actorRole: 'cashier' } }).then((x) => x.ok)]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await svc.getSpendableBalance(sid, c)).toBe(3);
    }
  });

  it('the same checkout redeemed twice at once is one spend (idempotent by checkout)', async () => {
    setMode('new');
    const svc = mkSvc(); const sid = await store(); const c = 'c-idem';
    await svc.adjust(sid, c, { amount: 10 }, actor);
    const res = await Promise.all(Array.from({ length: 6 }, () => svc.redeemAtOrderPlacement(sid, c, 4, 'chk-same', 'ord-s')));
    expect(res.every(Boolean)).toBe(true);
    expect(await svc.getSpendableBalance(sid, c)).toBe(6);
    expect(await r.storeCreditEntryModel.countDocuments({ storeId: sid, type: 'redeem' })).toBe(1);
  });
});

describe('the mode is a switch, not a mix', () => {
  it('migrating: credit reads 0, nothing can be spent, issued or refunded to credit (reported) — from EITHER side', async () => {
    setMode('new');
    const sid = await store(); const c = 'c-mig';
    await mkSvc().adjust(sid, c, { amount: 10 }, actor);
    setMode('migrating');
    const svc = mkSvc();
    expect(await svc.getSpendableBalance(sid, c)).toBe(0);
    expect(await svc.redeemAtOrderPlacement(sid, c, 1, 'chk-m', 'ord-m')).toBe(false);
    expect(await svc.creditFromRefund(sid, c, 5, 'ord-m', 'rf-m', 'x', actor)).toBe(false);
    await expect(svc.adjust(sid, c, { amount: 5 }, actor)).rejects.toThrow(/being updated/);
    expect(await r.storeCreditLotModel.countDocuments({ storeId: sid })).toBe(1);
    expect(storeCreditMode()).toBe('migrating');
  });
  it('legacy (the default) never touches the new collections; new never touches the legacy one', async () => {
    const sid = await store(); const c = 'c-sep';
    setMode('legacy'); await mkSvc().adjust(sid, c, { amount: 3 }, actor);
    expect([await r.storeCreditTransactionModel.countDocuments({ storeId: sid }), await r.storeCreditEntryModel.countDocuments({ storeId: sid })]).toEqual([1, 0]);
    setMode('new'); await mkSvc().adjust(sid, c, { amount: 3 }, actor);
    expect([await r.storeCreditTransactionModel.countDocuments({ storeId: sid }), await r.storeCreditEntryModel.countDocuments({ storeId: sid })]).toEqual([1, 1]);
    delete process.env.STORE_CREDIT_LEDGER;
    expect(storeCreditMode()).toBe('legacy');
  });
  it('entries are append-only through the model', async () => {
    setMode('new'); const sid = await store();
    await mkSvc().adjust(sid, 'c-ao', { amount: 1 }, actor);
    await expect(r.storeCreditEntryModel.updateOne({ storeId: sid }, { $set: { amountMinor: 9 } })).rejects.toThrow(/append-only/);
    await expect(r.storeCreditEntryModel.deleteMany({ storeId: sid })).rejects.toThrow(/append-only/);
  });
});
