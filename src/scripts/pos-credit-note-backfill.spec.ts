/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { EJSON } from 'bson';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';
import { PosService } from '../pos/pos.service';
import { assertSafeTarget, backfillCreditNotes, backfillCreditNotesDown, CNB } from './pos-credit-note-backfill.lib';

jest.setTimeout(180_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const db = () => h.conn.db!;
const num = (v: any) => (v && typeof v.toNumber === 'function' ? v.toNumber() : v);
const snap = async () => {
  const out: Record<string, string> = {};
  for (const c of await db().listCollections().toArray()) out[c.name] = EJSON.stringify(await db().collection(c.name).find({}).sort({ _id: 1 }).toArray());
  return out;
};
const T = (m: number) => new Date(Date.UTC(2026, 10, 4, 10, m));

/** Pre-G2.5 data: sales without invoices / per-line tax, refunds without notes; a decimal-only (pre-minor) refund; a void. */
async function seedLegacy() {
  const s = await seedStore(h, { stock: 50, price: 10 });
  const sid = new ObjectId().toHexString();
  const line = (price: number, qty: number, over: any = {}) => ({ _id: new ObjectId(), productId: 'p', variantId: 'v', name: 'Tea', sku: 'TEA-1', price, qty, lineTotal: price * qty, refundedQty: 0, ...over });
  // sale A: 2 lines, 10% tax, refunded twice (partial, then the rest = "full" listing the remaining units)
  const a1 = line(10, 3), a2 = line(5, 2);
  const A = { _id: new ObjectId(), saleNumber: 'POS-00001', storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, status: 'refunded', currency: 'USD', currencyExponent: 2, items: [a1, a2], subtotal: 40, discount: 0, tax: 4, total: 44, paymentMethod: 'cash', payments: [{ method: 'cash', amount: 44 }], refundedAmount: 44, createdAt: T(0) };
  // sale B: card, 5.50, refunded in full by a refund written before the minor twins (decimal only, no amountMinor)
  const b1 = line(2.5, 2);
  const B = { _id: new ObjectId(), saleNumber: 'POS-00002', storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, status: 'refunded', currency: 'USD', currencyExponent: 2, items: [b1], subtotal: 5, discount: 0, tax: 0.5, total: 5.5, paymentMethod: 'card', payments: [{ method: 'card', amount: 5.5 }], refundedAmount: 5.5, createdAt: T(1) };
  // sale C: voided
  const c1 = line(7, 1);
  const C = { _id: new ObjectId(), saleNumber: 'POS-00003', storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, status: 'voided', voidedAt: T(30), voidedBy: s.managerId, voidReason: 'typo', currency: 'USD', currencyExponent: 2, items: [c1], subtotal: 7, discount: 0, tax: 0.7, total: 7.7, paymentMethod: 'cash', payments: [{ method: 'cash', amount: 7.7 }], refundedAmount: 0, createdAt: T(2) };
  await db().collection(CNB.sales).insertMany([A, B, C]);
  const r = (saleId: any, seq: number, at: Date, amount: number, items: any[], tenders: any[], over: any = {}) => ({ _id: new ObjectId(), saleId: String(saleId), seq, storeId: s.storeId, kind: 'partial', amount, currency: 'USD', currencyExponent: 2, tenders, items, employeeId: s.managerId, reason: 'x', createdAt: at, ...over });
  const rA1 = r(A._id, 0, T(10), 16.5, [{ saleItemId: String(a1._id), qty: 1 }, { saleItemId: String(a2._id), qty: 1 }], [{ method: 'cash', amount: 16.5 }], { amountMinor: 1650 });
  const rA2 = r(A._id, 1, T(20), 27.5, [{ saleItemId: String(a1._id), qty: 2 }, { saleItemId: String(a2._id), qty: 1 }], [{ method: 'cash', amount: 27.5 }], { amountMinor: 2750, kind: 'full' });
  const rB = r(B._id, 0, T(15), 5.5, [{ saleItemId: String(b1._id), qty: 2 }], [{ method: 'card', amount: 5.5 }], { kind: 'full' }); // no amountMinor: decimal only
  await db().collection(CNB.refunds).insertMany([rA1, rA2, rB]);
  return { s, A, B, C, rA1, rA2, rB };
}

describe('safety', () => {
  it('refuses a database that does not look like dev/test unless BOTH production flags are given', () => {
    expect(() => assertSafeTarget('solvexo_prod', {})).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { production: true })).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { production: true, iHaveABackup: true })).not.toThrow();
    expect(() => assertSafeTarget('solvexo_dev', {})).not.toThrow();
  });
});

describe('dry run', () => {
  it('writes nothing and reports what it would do (counts, numbers, legacy decimal amounts)', async () => {
    await seedLegacy();
    const before = await snap();
    const r = await backfillCreditNotes(db(), { dryRun: true });
    expect(await snap()).toEqual(before);
    expect([r.totalCandidates, r.totalWritten, r.totalSkipped]).toEqual([4, 4, 0]); // 3 refunds + 1 void
    expect([r.stores[0].refundCandidates, r.stores[0].voidCandidates, r.stores[0].legacyMajorAmounts]).toEqual([3, 1, 1]);
    expect([r.stores[0].firstNumber, r.stores[0].lastNumber]).toEqual(['CN-B000001', 'CN-B000004']);
  });
});

describe('up', () => {
  it('writes marked CN-B notes in chronological order with the proration of a live return; the note equals what was paid out', async () => {
    const d = await seedLegacy();
    const r = await backfillCreditNotes(db(), { dryRun: false, now: () => new Date('2026-11-09T12:00:00Z'), batchId: 'b1' });
    expect(r.totalWritten).toBe(4);
    const notes: any[] = await db().collection(CNB.notes).find({}).sort({ seq: -1 }).toArray(); // seq is negative: −1 is the first
    expect(notes.map((n) => n.number)).toEqual(['CN-B000001', 'CN-B000002', 'CN-B000003', 'CN-B000004']);
    expect(notes.map((n) => n.seq)).toEqual([-1, -2, -3, -4]);
    // chronological: rA1 (10) , rB (15), rA2 (20), void C (30)
    expect(notes.map((n) => n.backfill.originalId)).toEqual([String(d.rA1._id), String(d.rB._id), String(d.rA2._id), String(d.C._id)]);
    expect(notes.map((n) => n.kind)).toEqual(['return', 'return', 'return', 'void']);
    // marked, dated like the original, linked to sale AND shift
    for (const n of notes) {
      expect(n.backfill.backfilledAt).toEqual(new Date('2026-11-09T12:00:00Z'));
      expect([n.backfill.batchId, n.fiscal.status, n.approvedBy]).toEqual(['b1', 'not_enabled', null]);
    }
    expect(notes[0].createdAt).toEqual(T(10));
    expect([notes[0].backfill.originalType, notes[3].backfill.originalType]).toEqual(['refund', 'void']);
    expect([notes[0].saleId, notes[0].saleSessionId]).toEqual([String(d.A._id), d.A.sessionId]);
    expect(notes[0].refundId).toBe(String(d.rA1._id));
    // money: each note equals its refund (and Σ of lines = the note); decimal-only refund converted by the sale's exponent
    const total = (n: any) => num(n.totalMinor);
    expect(notes.map(total)).toEqual([1650, 550, 2750, 770]);
    for (const n of notes) expect(n.lines.reduce((s: number, l: any) => s + num(l.totalMinor), 0)).toBe(total(n));
    // cumulative proration over the two refunds of sale A: together exactly the sale's lines (4000 net + 400 tax)
    expect(notes[0].lines.map((l: any) => [l.qty, num(l.netMinor), num(l.taxMinor)])).toEqual([[1, 1000, 100], [1, 500, 50]]);
    expect(notes[2].lines.map((l: any) => [l.qty, num(l.netMinor), num(l.taxMinor)])).toEqual([[2, 2000, 200], [1, 500, 50]]);
    expect(notes[1].tenders).toEqual([{ method: 'card', amountMinor: expect.anything() }]);
    expect(num(notes[3].tenders[0].amountMinor)).toBe(770);
    expect(notes[3].scope).toBe('full');
    expect([notes[0].scope, notes[2].scope]).toEqual(['partial', 'full']);
    // the audit trail of the run, and nothing else changed
    expect(await db().collection(CNB.audit).countDocuments({ action: 'credit_notes_backfilled' })).toBe(1);
    expect(await db().collection('posettings').countDocuments({ creditNoteCounter: { $exists: true } })).toBe(0);
  });

  it('is idempotent (a second run writes 0) and resumable (a sliced run continues with the next number; same result as one run)', async () => {
    await seedLegacy();
    await backfillCreditNotes(db(), { dryRun: false, maxDocs: 1, batchId: 'b1' });
    expect(await db().collection(CNB.notes).countDocuments({})).toBe(1);
    await backfillCreditNotes(db(), { dryRun: false, maxDocs: 2, batchId: 'b2' });
    const again = await backfillCreditNotes(db(), { dryRun: false, batchId: 'b3' });
    expect(again.totalWritten).toBe(1);
    const second = await backfillCreditNotes(db(), { dryRun: false, batchId: 'b4' });
    expect([second.totalCandidates, second.totalWritten]).toEqual([0, 0]);
    const nums = (await db().collection(CNB.notes).find({}).sort({ seq: -1 }).toArray()).map((n: any) => `${n.number}:${n.backfill.originalType}`);
    expect(nums).toEqual(['CN-B000001:refund', 'CN-B000002:refund', 'CN-B000003:refund', 'CN-B000004:void']);
  });

  it('a refund that already has a real credit note is left alone; nothing is guessed: a refund of a missing sale / unknown line is LISTED and skipped', async () => {
    const d = await seedLegacy();
    await db().collection(CNB.notes).insertOne({ _id: new ObjectId(), storeId: d.s.storeId, number: 'CN-000001', seq: 1, saleId: String(d.B._id), kind: 'return', refundId: String(d.rB._id), lines: [], backfill: null, createdAt: T(16) } as any);
    await db().collection(CNB.refunds).insertMany([
      { _id: new ObjectId(), saleId: new ObjectId().toHexString(), seq: 0, storeId: d.s.storeId, amount: 1, currencyExponent: 2, tenders: [], items: [], createdAt: T(40) },
      { _id: new ObjectId(), saleId: String(d.A._id), seq: 2, storeId: d.s.storeId, amount: 1, currencyExponent: 2, tenders: [], items: [{ saleItemId: new ObjectId().toHexString(), qty: 1 }], createdAt: T(41) },
    ]);
    const r = await backfillCreditNotes(db(), { dryRun: false });
    expect(r.totalWritten).toBe(3); // rA1, rA2, void — rB has its own note
    expect(r.stores[0].skipped.map((x) => x.reason).sort()).toEqual(['sale_missing', 'unknown_sale_line']);
    expect(await db().collection(CNB.notes).countDocuments({ number: 'CN-000001' })).toBe(1);
  });

  it('the live series is untouched: the next real return after the backfill is CN-000001', async () => {
    const d = await seedLegacy();
    await backfillCreditNotes(db(), { dryRun: false });
    const svc = new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
    const tok = jwt.sign({ employeeId: d.s.managerId, storeId: d.s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
    const sid = new ObjectId();
    await h.repos.registerSessionModel.collection.insertOne({ _id: sid, storeId: d.s.storeId, registerId: d.s.registerId, employeeId: d.s.cashierId, status: 'open', openedAt: new Date(), openingCash: 0, totalSales: 0, totalTransactions: 0 });
    const sold: any = (await svc.createSale(d.s.sellerId, { storeId: d.s.storeId, sessionId: String(sid), registerId: d.s.registerId, employeeId: d.s.cashierId, items: [{ productId: d.s.productId, variantId: d.s.variantId, qty: 1 }], paymentMethod: 'cash' } as any, tok)).data;
    const ref: any = await svc.refundSale(d.s.sellerId, String(sold._id), {} as any, tok);
    expect(ref.data.creditNote.number).toBe('CN-000001');
  });
});

describe('down', () => {
  it('removes exactly what up added — the database is byte for byte what it was (dry run first, then real)', async () => {
    await seedLegacy();
    const before = await snap();
    await backfillCreditNotes(db(), { dryRun: false });
    expect(await snap()).not.toEqual(before);
    expect(await backfillCreditNotesDown(db(), { dryRun: true })).toEqual({ notes: 4, audit: 1 });
    expect(await db().collection(CNB.notes).countDocuments({})).toBe(4); // a dry run removes nothing
    expect(await backfillCreditNotesDown(db(), { dryRun: false })).toEqual({ notes: 4, audit: 1 });
    expect(await snap()).toEqual(before);
    // and up again gives the same numbers
    await backfillCreditNotes(db(), { dryRun: false });
    expect((await db().collection(CNB.notes).find({}).sort({ seq: -1 }).toArray()).map((n: any) => n.number)).toEqual(['CN-B000001', 'CN-B000002', 'CN-B000003', 'CN-B000004']);
  });
});
