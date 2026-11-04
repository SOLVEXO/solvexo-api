/* eslint-disable prettier/prettier */
import { ObjectId } from 'mongodb';
import { EJSON } from 'bson';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';
import { PosService } from '../pos/pos.service';
import { checkMinorPairs } from '../common/money-minor.util';
import { assertSafeTarget, backfillMinor, backfillMinorDown, G1B } from './pos-g1b-minor-backfill.lib';

jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const db = () => h.conn.db!;
const num = (v: any) => (v && typeof v.toNumber === 'function' ? v.toNumber() : v);
const snap = async () => {
  const out: Record<string, string> = {};
  for (const c of [G1B.sales, G1B.sessions, G1B.payments, G1B.refunds, G1B.stores]) out[c] = EJSON.stringify(await db().collection(c).find({}).sort({ _id: 1 }).toArray());
  return out;
};

/** Legacy rows as written before G1b: decimals only. One USD store; a JPY store with NO currency snapshot (pre-5B shape). */
async function seedLegacy() {
  const usd = await seedStore(h, { stock: 50, price: 10 });
  const sid = new ObjectId();
  await db().collection(G1B.sessions).insertMany([
    { _id: sid, storeId: usd.storeId, registerId: usd.registerId, employeeId: usd.cashierId, openedAt: new Date(), status: 'open', currency: 'USD', currencyExponent: 2, openingCash: 100, cashSales: 105.5, cardSales: 40, otherSales: 0, totalSales: 145.5, totalTransactions: 7, totalRefunds: 0, cashAdjustments: [{ type: 'cash_in', amount: 10.5, reason: 'x', employeeId: 'm' }] },
    { _id: new ObjectId(), storeId: usd.storeId, registerId: usd.registerId, employeeId: usd.cashierId, openedAt: new Date(), closedAt: new Date(), status: 'closed', currency: 'USD', currencyExponent: 2, openingCash: 50, closingCash: 160, expectedCash: 161.5, cashDifference: -1.5, cashSales: 3.3000000000000007, cardSales: 20, otherSales: 0, totalSales: 23.3, totalRefunds: 5, cardReconciliation: { status: 'variance_approved', slipTotal: 18.5, expectedCard: 20, variance: -1.5 } },
  ]);
  const saleId = new ObjectId();
  await db().collection(G1B.sales).insertMany([
    { _id: saleId, saleNumber: 'L-1', storeId: usd.storeId, sessionId: String(sid), registerId: usd.registerId, employeeId: usd.cashierId, status: 'partially_refunded', currency: 'USD', currencyExponent: 2,
      items: [{ price: 10, listPrice: 10, qty: 2, lineTotal: 20, refundedQty: 0 }, { price: 4.5, qty: 1, lineTotal: 4.5, refundedQty: 0 }], subtotal: 24.5, discount: 2, discountType: 'amount', discountValue: 2, tax: 2.25, total: 24.75, changeGiven: 5.25, paymentShortfall: 0, refundedAmount: 5,
      payments: [{ method: 'card', amount: 12.75, reference: 'A' }, { method: 'cash', amount: 12, tendered: 17.25 }], refunds: [{ amount: 5, kind: 'partial', tenders: [{ method: 'card', amount: 5 }], items: [], employeeId: 'm' }], createdAt: new Date() },
    { _id: new ObjectId(), saleNumber: 'L-2', storeId: usd.storeId, sessionId: String(sid), registerId: usd.registerId, employeeId: usd.cashierId, status: 'held', items: [{ price: 10, qty: 1, lineTotal: 10 }], subtotal: 10, discount: 0, tax: 0, total: 10, changeGiven: 0, paymentShortfall: 0, refundedAmount: 0, payments: [], refunds: [], createdAt: new Date() }, // held + NO currency snapshot → inferred from the store (USD)
  ]);
  await db().collection(G1B.payments).insertOne({ _id: new ObjectId(), saleId: String(saleId), lineNo: 0, tender: 'card', amount: 12.75, tendered: null, status: 'recorded_unverified', storeId: usd.storeId });
  await db().collection(G1B.refunds).insertOne({ _id: new ObjectId(), saleId: String(saleId), seq: 0, reference: 'L-1-R1', kind: 'partial', amount: 5, tenders: [{ method: 'card', amount: 5 }], items: [], status: 'recorded_unverified', storeId: usd.storeId });
  const jpy = await seedStore(h, { stock: 10, price: 500, baseCurrency: 'JPY' });
  await db().collection(G1B.sales).insertOne({ _id: new ObjectId(), saleNumber: 'J-1', storeId: jpy.storeId, sessionId: 'x', registerId: jpy.registerId, employeeId: jpy.cashierId, status: 'completed', items: [{ price: 500, qty: 2, lineTotal: 1000 }], subtotal: 1000, discount: 0, tax: 0, total: 1000, changeGiven: 0, paymentShortfall: 0, refundedAmount: 0, payments: [{ method: 'cash', amount: 1000 }], refunds: [], createdAt: new Date() }); // NO snapshot: JPY → exponent 0
  await db().collection(G1B.stores).updateOne({ _id: new ObjectId(usd.storeId) }, { $set: { 'registers.0.defaultFloatCash': 150.25 } });
  return { usd, jpy, sid: String(sid), saleId: String(saleId) };
}

describe('safety', () => {
  it('refuses a database that does not look like dev/test unless BOTH production flags are given', () => {
    expect(() => assertSafeTarget('solvexo_prod', {})).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { production: true })).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { iHaveABackup: true })).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { production: true, iHaveABackup: true })).not.toThrow();
    expect(() => assertSafeTarget('solvexo_dev', {})).not.toThrow();
    expect(() => assertSafeTarget('pos_test_123', {})).not.toThrow();
  });
});

describe('backfill: dry run → up → idempotent → down', () => {
  it('DRY RUN writes nothing and reports counts, batch size, off-grid / noise / inferred currency and an estimate', async () => {
    await seedLegacy();
    const before = await snap();
    const r = await backfillMinor(db(), { dryRun: true, batchSize: 2 });
    expect(await snap()).toEqual(before); // byte-identical
    expect(r).toMatchObject({ dryRun: true, batchSize: 2, assumedWriteDocsPerSec: 500 });
    const by = Object.fromEntries(r.collections.map((c) => [c.collection, c]));
    expect(by[G1B.sales]).toMatchObject({ candidates: 3, written: 0, currencyInferred: 2 }); // the held sale and the JPY sale have no snapshot
    expect(by[G1B.sessions]).toMatchObject({ candidates: 2, written: 0 });
    expect(by[G1B.sessions].floatNoise).toBeGreaterThan(0); // 3.3000000000000007
    expect(by[G1B.payments].candidates).toBe(1);
    expect(by[G1B.refunds].candidates).toBe(1);
    expect(by[G1B.stores].candidates).toBeGreaterThanOrEqual(1);
    expect(r.totalCandidates).toBe(r.collections.reduce((a, c) => a + c.candidates, 0));
    expect(r.estimatedSeconds).toBeGreaterThanOrEqual(0);
    expect(by[G1B.sales].offGrid).toEqual([]);
  });

  it('UP fills every twin (checker-clean), with the right exponent, markers and snapshot; a second run is a no-op', async () => {
    const { sid, saleId } = await seedLegacy();
    const r = await backfillMinor(db(), { dryRun: false, batchSize: 2 });
    expect(r.collections.find((c) => c.collection === G1B.sales)!.written).toBe(3);

    const sale: any = await db().collection(G1B.sales).findOne({ _id: new ObjectId(saleId) });
    expect([sale.subtotalMinor, sale.discountMinor, sale.discountValueMinor, sale.taxMinor, sale.totalMinor, sale.changeGivenMinor, sale.refundedAmountMinor].map(num)).toEqual([2450, 200, 200, 225, 2475, 525, 500]);
    expect(sale.items.map((i: any) => [num(i.priceMinor), num(i.listPriceMinor), num(i.lineTotalMinor)])).toEqual([[1000, 1000, 2000], [450, undefined, 450]]);
    expect(sale.payments.map((p: any) => [num(p.amountMinor), num(p.tenderedMinor)])).toEqual([[1275, undefined], [1200, 1725]]);
    expect([num(sale.refunds[0].amountMinor), num(sale.refunds[0].tenders[0].amountMinor)]).toEqual([500, 500]);
    expect(sale.minorBackfilledAt).toBeInstanceOf(Date);
    expect(checkMinorPairs(sale, PosService.MINOR_PAIRS.sale, 2)).toEqual([]);

    const held: any = await db().collection(G1B.sales).findOne({ saleNumber: 'L-2' });
    expect([held.currency, held.currencyExponent, held.currencyInferred, num(held.totalMinor)]).toEqual(['USD', 2, true, 1000]);
    const jpy: any = await db().collection(G1B.sales).findOne({ saleNumber: 'J-1' });
    expect([jpy.currency, jpy.currencyExponent, jpy.currencyInferred, num(jpy.totalMinor), num(jpy.items[0].priceMinor)]).toEqual(['JPY', 0, true, 1000, 500]); // exponent 0: the ISO table

    const open: any = await db().collection(G1B.sessions).findOne({ _id: new ObjectId(sid) });
    expect([open.openingCashMinor, open.cashSalesMinor, open.cardSalesMinor, open.otherSalesMinor, open.totalSalesMinor, open.totalRefundsMinor].map(num)).toEqual([10000, 10550, 4000, 0, 14550, 0]);
    expect(num(open.cashAdjustments[0].amountMinor)).toBe(1050);
    const closed: any = await db().collection(G1B.sessions).findOne({ status: 'closed' });
    expect([num(closed.cashSalesMinor), num(closed.expectedCashMinor), num(closed.cashDifferenceMinor), num(closed.cardReconciliation.varianceMinor)]).toEqual([330, 16150, -150, -150]); // 3.3000000000000007 → 330
    expect(checkMinorPairs(open, PosService.MINOR_PAIRS.session, 2)).toEqual([]);
    expect(checkMinorPairs(closed, PosService.MINOR_PAIRS.session, 2)).toEqual([]);

    const pay: any = await db().collection(G1B.payments).findOne({});
    const ref: any = await db().collection(G1B.refunds).findOne({});
    expect([num(pay.amountMinor), num(ref.amountMinor), num(ref.tenders[0].amountMinor)]).toEqual([1275, 500, 500]);
    const store: any = await db().collection(G1B.stores).findOne({ 'registers.defaultFloatCash': 150.25 });
    expect(num(store.registers[0].defaultFloatCashMinor)).toBe(15025);

    const after = await snap();
    const again = await backfillMinor(db(), { dryRun: false });
    expect(again.totalCandidates).toBe(0);
    expect(await snap()).toEqual(after); // idempotent: nothing changed
  });

  it('never overwrites a LIVE dual-written value and does not mark live rows', async () => {
    const s = await seedStore(h, { stock: 10, price: 10 });
    const live = { _id: new ObjectId(), saleNumber: 'N-1', storeId: s.storeId, status: 'completed', currency: 'USD', currencyExponent: 2, items: [], subtotal: 1, discount: 0, tax: 0, total: 1, totalMinor: 100, subtotalMinor: 100, changeGiven: 0, paymentShortfall: 0, refundedAmount: 0, payments: [], refunds: [] };
    await db().collection(G1B.sales).insertOne(live as any);
    const r = await backfillMinor(db(), { dryRun: false });
    expect(r.collections.find((c) => c.collection === G1B.sales)!.candidates).toBe(0);
    expect(((await db().collection(G1B.sales).findOne({ saleNumber: 'N-1' })) as any).minorBackfilledAt).toBeUndefined();
  });

  it('a genuinely OFF-GRID value is rounded and REPORTED (not silently hidden)', async () => {
    const s = await seedStore(h, { stock: 10, price: 10 });
    await db().collection(G1B.sales).insertOne({ _id: new ObjectId(), saleNumber: 'X-1', storeId: s.storeId, status: 'completed', currency: 'USD', currencyExponent: 2, items: [], subtotal: 3.305, discount: 0, tax: 0, total: 3.305, changeGiven: 0, paymentShortfall: 0, refundedAmount: 0, payments: [], refunds: [] });
    const r = await backfillMinor(db(), { dryRun: true });
    const off = r.collections.find((c) => c.collection === G1B.sales)!.offGrid;
    expect(off.map((o) => [o.field, o.value, o.roundedMinor])).toEqual([['subtotal', 3.305, 331], ['total', 3.305, 331]]);
  });

  it('RESUMABLE: stop part-way (a crash), resume from the checkpoint, end in the same state as an uninterrupted run', async () => {
    await seedLegacy();
    const partial = await backfillMinor(db(), { dryRun: false, batchSize: 1, maxDocs: 2 });
    expect(partial.collections.reduce((a, c) => a + c.written, 0)).toBeLessThanOrEqual(2);
    const cp = await db().collection(G1B.checkpoints).countDocuments({});
    expect(cp).toBeGreaterThanOrEqual(1);
    await backfillMinor(db(), { dryRun: false, batchSize: 1, resume: true });
    const resumed = await snap();
    // reference: the same legacy data in a fresh run
    await h.reset();
    await seedLegacy();
    await backfillMinor(db(), { dryRun: false, batchSize: 500 });
    const strip = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.replace(/"minorBackfilledAt":\{"\$date":"[^"]+"\}/g, '"mb":1').replace(/"_id":\{"\$oid":"[0-9a-f]+"\}/g, '"_id":0').replace(/"(storeId|registerId|employeeId|sessionId|saleId)":"[0-9a-f]{24}"/g, '"$1":"x"')]));
    expect(Object.keys(resumed)).toEqual(Object.keys(await snap()));
    expect(strip(resumed)[G1B.payments]).toEqual(strip(await snap())[G1B.payments]);
  });

  it('a row changed between the read and the write (a concurrent refund) is retried from a fresh read — never overwritten blindly', async () => {
    const { saleId } = await seedLegacy();
    let injected = false;
    const r = await backfillMinor(db(), {
      dryRun: false, batchSize: 10,
      beforeWrite: async (c, doc) => {
        if (c === G1B.sales && String(doc._id) === saleId && !injected) {
          injected = true; // a refund lands after the backfill read the document
          await db().collection(G1B.sales).updateOne({ _id: doc._id }, { $set: { refundedAmount: 8 }, $push: { refunds: { amount: 3, kind: 'partial', tenders: [{ method: 'card', amount: 3 }] } } as any });
        }
      },
    });
    expect(r.collections.find((c) => c.collection === G1B.sales)!.conflictsRetried).toBeGreaterThanOrEqual(1);
    const sale: any = await db().collection(G1B.sales).findOne({ _id: new ObjectId(saleId) });
    expect([sale.refundedAmount, num(sale.refundedAmountMinor), sale.refunds.length, num(sale.refunds[1].amountMinor)]).toEqual([8, 800, 2, 300]); // the NEW refund is covered too
    expect(checkMinorPairs(sale, PosService.MINOR_PAIRS.sale, 2)).toEqual([]);
  });

  it('a shift that is open during the backfill keeps correct counters when a live sale lands afterwards', async () => {
    const { usd, sid } = await seedLegacy();
    await backfillMinor(db(), { dryRun: false });
    const svc = new PosService({ repositories: h.repos } as any, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
    await svc.createSale(usd.sellerId, { storeId: usd.storeId, sessionId: sid, registerId: usd.registerId, employeeId: usd.cashierId, items: [{ productId: usd.productId, variantId: usd.variantId, qty: 2 }], paymentMethod: 'cash' } as any, undefined);
    const open: any = await db().collection(G1B.sessions).findOne({ _id: new ObjectId(sid) });
    expect([open.cashSales, num(open.cashSalesMinor), num(open.totalSalesMinor)]).toEqual([125.5, 12550, 16550]);
  });

  it('DOWN removes only what the backfill added and restores the legacy rows byte-for-byte; live rows are untouched', async () => {
    await seedLegacy();
    const before = await snap();
    const dry = await backfillMinorDown(db(), { dryRun: true });
    expect(dry.find((r) => r.collection === G1B.sales)!.rows).toBe(0); // nothing to remove yet
    await backfillMinor(db(), { dryRun: false });
    expect(await snap()).not.toEqual(before);
    const down = await backfillMinorDown(db(), { dryRun: false });
    expect(down.find((r) => r.collection === G1B.sales)!.rows).toBe(3);
    expect(await snap()).toEqual(before); // BYTE-FOR-BYTE
    expect(await db().collection(G1B.checkpoints).countDocuments({})).toBe(0);
  });
});
