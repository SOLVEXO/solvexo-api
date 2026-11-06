/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosReceiptService } from './pos-receipt.service';
import { PublicReceiptController } from './public-receipt.controller';
import { MongoHarness, oidStr, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/**
 * G2.5 on a real replica-set MongoDB: gap-free tax-invoice numbers, credit notes for every return / void, per-line tax reversal with
 * cumulative proration (exponent 0 / 2 / 3), race-safe partial returns, restock per line, return approval rules, a held sale's coupon
 * code, the public tax-invoice / credit-note pages, PCT / HS snapshots.
 */
jest.setTimeout(240_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
let n = 0;
async function fresh(opts: Parameters<typeof seedStore>[1] = {}) {
  const s = await seedStore(h, { stock: 20, ...opts });
  const svc = makeService();
  const sid = String(new Types.ObjectId());
  await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
  return { s, svc, sid };
}
type X = Awaited<ReturnType<typeof fresh>>;
const dto = (x: X, over: any = {}) => ({ storeId: x.s.storeId, sessionId: x.sid, registerId: x.s.registerId, employeeId: x.s.cashierId, items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }], paymentMethod: 'cash', ...over });
const sell = async (x: X, over: any = {}, who: 'manager' | 'cashier' = 'manager') => ((await x.svc.createSale(x.s.sellerId, dto(x, over) as any, tok(x.s, who))) as any).data;
const refund = (x: X, saleId: string, body: any = {}, who: 'manager' | 'cashier' = 'manager') => x.svc.refundSale(x.s.sellerId, saleId, body, tok(x.s, who)) as Promise<any>;
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const msg = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.message ?? e?.message ?? null; } };
const reasons = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.reasons ?? null; } };
const coupon = (s: Seed, over: any = {}) => h.repos.couponModel.create({ scope: 'seller', storeId: s.storeId, sellerId: s.sellerId, code: `G${++n}`, discountType: 'percentage', discountValue: 10, posEnabled: true, isActive: true, currency: 'USD', ...over });
const cns = (storeId: string) => h.repos.posCreditNoteModel.find({ storeId }).sort({ seq: 1 }).lean() as Promise<any[]>;

describe('tax-invoice numbers: per store, gap-free, immutable', () => {
  it('every completed sale gets the next number; a held sale gets none until it is completed', async () => {
    const x = await fresh();
    const a = await sell(x); const b = await sell(x);
    expect([a.invoice.number, b.invoice.number]).toEqual(['INV-000001', 'INV-000002']);
    expect([a.invoice.seq, b.invoice.seq]).toEqual([1, 2]);
    const held = await sell(x, { status: 'held' });
    expect(held.invoice ?? null).toBeNull();
    const done: any = await x.svc.completeSale(x.s.sellerId, String(held._id), { paymentMethod: 'cash' } as any, tok(x.s, 'manager'));
    expect(done.data.invoice.number).toBe('INV-000003');
    expect(done.data.items[0]).toMatchObject({ netMinor: 1000, taxMinor: 0 });
  });

  it('a sale that fails (not enough stock) leaves NO hole; numbers are per store', async () => {
    const x = await fresh({ stock: 1 }); const y = await fresh();
    await sell(x);
    expect(await code(x.svc.createSale(x.s.sellerId, dto(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 5 }] }) as any, tok(x.s, 'manager')))).not.toBeNull();
    expect((await h.repos.saleModel.countDocuments({ storeId: x.s.storeId }))).toBe(1);
    h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(x.s.variantId) }, { $set: { stock: 5 } });
    expect((await sell(x)).invoice.number).toBe('INV-000002');
    expect((await sell(y)).invoice.number).toBe('INV-000001');
  });

  it('eight tills selling at once: numbers 1..8, each exactly once, no gap, no duplicate', async () => {
    const x = await fresh();
    const sales = await Promise.all(Array.from({ length: 8 }, () => sell(x)));
    const seqs = sales.map((s) => s.invoice.seq).sort((p, q) => p - q);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(sales.map((s) => s.invoice.number)).size).toBe(8);
  });

  it('an invoice number cannot be changed or removed afterwards — by any update path; ordinary updates still work', async () => {
    const x = await fresh();
    const a = await sell(x);
    await expect(h.repos.saleModel.updateOne({ _id: a._id }, { $set: { 'invoice.number': 'INV-999999' } })).rejects.toThrow(/immutable/);
    await expect(h.repos.saleModel.findOneAndUpdate({ _id: a._id }, { $set: { 'invoice.seq': 99 } })).rejects.toThrow(/immutable/);
    await expect(h.repos.saleModel.updateMany({ storeId: x.s.storeId }, { $unset: { invoice: 1 } })).rejects.toThrow(/immutable/);
    await h.repos.saleModel.updateOne({ _id: a._id }, { $set: { notes: 'fine' } });
    expect(((await h.repos.saleModel.findById(a._id).lean()) as any).invoice.number).toBe('INV-000001');
  });

  it('an offline sale gets its FINAL number when it syncs (device time kept as the issue date); the provisional OFF- number stays linked', async () => {
    const x = await fresh();
    await sell(x);
    const at = new Date(Date.now() - 3_600_000);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(x.sid) }, { $set: { openedAt: new Date(Date.now() - 7_200_000) } }); // the shift was open when the offline sale was made
    const off = await sell(x, { offline: true, clientCreatedAt: at.toISOString(), offlineRef: 'OFF-DEV-0007' }, 'manager');
    expect(off.invoice).toMatchObject({ number: 'INV-000002', offlineRef: 'OFF-DEV-0007' });
    expect(new Date(off.invoice.issuedAt).getTime()).toBe(at.getTime());
    expect((await sell(x)).invoice.number).toBe('INV-000003'); // numbers follow SYNC order; the issue date keeps the real time
  });

  it('the seller as registered (NTN, STRN, legal name, address) is snapshotted on the invoice; later edits do not change old invoices', async () => {
    const x = await fresh();
    await x.svc.updatePosSettings(x.s.sellerId, x.s.storeId, { taxNtn: '1234567-8', taxStrn: '3277876123456', taxLegalName: 'Test Traders (Pvt) Ltd', taxRegisteredAddress: '12 Mall Road, Lahore' } as any);
    const a = await sell(x);
    expect(a.invoice.seller).toEqual({ legalName: 'Test Traders (Pvt) Ltd', address: '12 Mall Road, Lahore', ntn: '1234567-8', strn: '3277876123456' });
    expect(a.invoice.fiscal).toMatchObject({ status: 'not_enabled', externalInvoiceNumber: null, qrPayload: null, attempts: 0 });
    await x.svc.updatePosSettings(x.s.sellerId, x.s.storeId, { taxNtn: '7654321-0' } as any);
    expect(((await h.repos.saleModel.findById(a._id).lean()) as any).invoice.seller.ntn).toBe('1234567-8');
    expect((await sell(x)).invoice.seller.ntn).toBe('7654321-0');
  });

  it('the PCT / HS code is snapshotted on the sale line at sale time', async () => {
    const x = await fresh();
    await h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(x.s.variantId) }, { $set: { hsCode: '09024090' } });
    const a = await sell(x);
    await h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(x.s.variantId) }, { $set: { hsCode: '21011100' } });
    expect(((await h.repos.saleModel.findById(a._id).lean()) as any).items[0].hsCode).toBe('09024090');
    await refund(x, String(a._id));
    expect((await cns(x.s.storeId))[0].lines[0].hsCode).toBe('09024090');
  });
});

describe('credit notes: one for every return and void', () => {
  it('a full refund, a partial refund and a void each make a credit note with the next number, linked to the invoice and lines', async () => {
    const x = await fresh({ taxRate: 0.1 });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 3 }] });
    const r1: any = await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 1 }], reasonCode: 'wrong_item' });
    expect(r1.data.creditNote).toMatchObject({ number: 'CN-000001', totalMinor: 1100 });
    const r2: any = await refund(x, String(a._id));
    expect(r2.data.creditNote).toMatchObject({ number: 'CN-000002', totalMinor: 2200 });
    const b = await sell(x);
    const v: any = await x.svc.voidSale(x.s.sellerId, String(b._id), { reasonCode: 'cashier_error' }, tok(x.s, 'manager'));
    expect(v.data.creditNote.number).toBe('CN-000003');
    const all = await cns(x.s.storeId);
    expect(all.map((c) => [c.kind, c.scope, c.invoiceNumber])).toEqual([['return', 'partial', 'INV-000001'], ['return', 'full', 'INV-000001'], ['void', 'full', 'INV-000002']]);
    expect(all[0].lines[0]).toMatchObject({ saleItemId: String(a.items[0]._id), qty: 1, name: 'Tea', sku: 'TEA-1', grossMinor: 1000, netMinor: 1000, taxMinor: 100, totalMinor: 1100, restock: true });
    expect(all[0]).toMatchObject({ reasonCode: 'wrong_item', saleId: String(a._id), currency: 'USD', currencyExponent: 2, grossMinor: 1000, taxMinor: 100, totalMinor: 1100, employeeId: x.s.managerId });
    expect(all[0].fiscal).toMatchObject({ status: 'not_enabled', externalInvoiceNumber: null });
    expect(all[0].seller).toBeDefined();
  });

  it('a credit note is immutable: no update, no delete, no replace', async () => {
    const x = await fresh();
    const a = await sell(x); await refund(x, String(a._id));
    const m = h.repos.posCreditNoteModel;
    await expect(m.updateOne({ storeId: x.s.storeId }, { $set: { totalMinor: 1 } })).rejects.toThrow(/append-only/);
    await expect(m.deleteOne({ storeId: x.s.storeId })).rejects.toThrow(/append-only/);
    await expect(m.findOneAndUpdate({ storeId: x.s.storeId }, { $set: { reason: 'x' } })).rejects.toThrow(/append-only/);
    const doc: any = await m.findOne({ storeId: x.s.storeId });
    doc.reason = 'changed';
    await expect(doc.save()).rejects.toThrow(/append-only/);
  });

  it('credit-note numbers are per store, gap-free and unique when several returns happen at once', async () => {
    const x = await fresh();
    const sales = await Promise.all(Array.from({ length: 6 }, () => sell(x)));
    await Promise.all(sales.map((s) => refund(x, String(s._id))));
    expect((await cns(x.s.storeId)).map((c) => c.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const y = await fresh(); const b = await sell(y);
    expect((await refund(y, String(b._id))).data.creditNote.number).toBe('CN-000001');
  });

  it('a retry with the same Idempotency-Key returns the same refund — and does not make a second credit note', async () => {
    const x = await fresh();
    const a = await sell(x);
    const r1: any = await x.svc.refundSale(x.s.sellerId, String(a._id), {}, tok(x.s, 'manager'), 'idem-1');
    const r2: any = await x.svc.refundSale(x.s.sellerId, String(a._id), {}, tok(x.s, 'manager'), 'idem-1');
    expect(r2.data.replayed).toBe(true);
    expect(r1.data.refundId).toBe(r2.data.refundId);
    expect((await cns(x.s.storeId)).length).toBe(1);
  });
});

describe.each([['JPY', 0, 1037], ['USD', 2, 10.37], ['KWD', 3, 10.375]] as const)('partial returns: prorated discount, tax and rounding — %s (exponent %i)', (cur, exp, price) => {
  const unit = 10 ** exp;
  it('returning 3 units one at a time credits exactly what was paid: Σ credit notes = sale total, Σ tax reversed = sale tax', async () => {
    const x = await fresh({ baseCurrency: cur, price: price as number, taxRate: 0.17 });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 3 }], discountType: 'percent', discountValue: 10 });
    expect(a.currencyExponent).toBe(exp);
    for (let i = 0; i < 3; i++) await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 1 }] });
    const notes = await cns(x.s.storeId);
    expect(notes.reduce((s2, c) => s2 + Number(c.totalMinor), 0)).toBe(Math.round(a.total * unit));
    expect(notes.reduce((s2, c) => s2 + Number(c.taxMinor), 0)).toBe(Math.round(a.tax * unit));
    expect(notes.reduce((s2, c) => s2 + Number(c.discountMinor), 0)).toBe(Math.round(a.discount * unit));
    const sale: any = await h.repos.saleModel.findById(a._id).lean();
    expect(sale.status).toBe('refunded');
    expect(Math.round(sale.refundedAmount * unit)).toBe(Math.round(a.total * unit));
    notes.forEach((c) => expect(Number(c.netMinor) + Number(c.taxMinor)).toBe(Number(c.totalMinor)));
  });

  it('two chunks (2 + 1) give the same total as three single returns', async () => {
    const x = await fresh({ baseCurrency: cur, price: price as number, taxRate: 0.17 });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 3 }], discountType: 'percent', discountValue: 10 });
    await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 2 }] });
    await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 1 }] });
    const notes = await cns(x.s.storeId);
    expect(notes.reduce((s2, c) => s2 + Number(c.totalMinor), 0)).toBe(Math.round(a.total * unit));
  });
});

describe('partial returns: rules, races, stock', () => {
  it('the quantity of a line cannot exceed sold − already returned; a line cannot be listed twice', async () => {
    const x = await fresh();
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }] });
    const id = String(a.items[0]._id);
    expect(await code(refund(x, String(a._id), { items: [{ saleItemId: id, qty: 3 }] }))).toBe('Cannot refund 3 of "Tea" — only 2 unreturned');
    expect(await code(refund(x, String(a._id), { items: [{ saleItemId: id, qty: 1 }, { saleItemId: id, qty: 1 }] }))).toMatch(/listed twice/);
    await refund(x, String(a._id), { items: [{ saleItemId: id, qty: 1 }] });
    expect(await code(refund(x, String(a._id), { items: [{ saleItemId: id, qty: 2 }] }))).toMatch(/only 1 unreturned/);
  });

  it('two tills returning the last units at the same moment: exactly one wins, the sale is never over-returned, stock is restored once', async () => {
    const x = await fresh();
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }] });
    const stockAfterSale = await stockOf(h, x.s.variantId);
    const id = String(a.items[0]._id);
    const results = await Promise.allSettled([refund(x, String(a._id), { items: [{ saleItemId: id, qty: 2 }] }), refund(x, String(a._id), { items: [{ saleItemId: id, qty: 2 }] }), refund(x, String(a._id))]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const sale: any = await h.repos.saleModel.findById(a._id).lean();
    expect(sale.items[0].refundedQty).toBe(2);
    expect(sale.status).toBe('refunded');
    expect(await stockOf(h, x.s.variantId)).toBe(stockAfterSale + 2);
    expect((await cns(x.s.storeId)).length).toBe(1);
  });

  it('restock per line: yes puts it back; no needs a reason and leaves the shelf alone; a custom item is never restocked', async () => {
    const x = await fresh();
    await h.repos.posSettingsModel.collection.updateOne({ storeId: x.s.storeId }, { $set: { customItemApprovalAboveMinor: 100000 } }, { upsert: true });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 3 }, { isCustom: true, customName: 'Engraving', unitPrice: 5, qty: 1 }] });
    const tea = String(a.items[0]._id); const eng = String(a.items[1]._id);
    const base = await stockOf(h, x.s.variantId);
    expect(await code(refund(x, String(a._id), { items: [{ saleItemId: tea, qty: 1, restock: false }] }))).toBe('RESTOCK_REASON_REQUIRED');
    expect(await stockOf(h, x.s.variantId)).toBe(base);
    await refund(x, String(a._id), { items: [{ saleItemId: tea, qty: 1, restock: false, restockReason: 'opened and spilled' }] });
    expect(await stockOf(h, x.s.variantId)).toBe(base);
    await refund(x, String(a._id), { items: [{ saleItemId: tea, qty: 1 }, { saleItemId: eng, qty: 1 }] });
    expect(await stockOf(h, x.s.variantId)).toBe(base + 1);
    const notes = await cns(x.s.storeId);
    expect(notes[0].lines[0]).toMatchObject({ restock: false, restockReason: 'opened and spilled' });
    expect(notes[1].lines.map((l: any) => [l.name, l.restock])).toEqual([['Tea', true], ['Engraving', false]]);
  });

  it('an exempt custom item reverses no tax; a taxed line reverses its own tax', async () => {
    const x = await fresh({ taxRate: 0.1 });
    await h.repos.posSettingsModel.collection.updateOne({ storeId: x.s.storeId }, { $set: { customItemApprovalAboveMinor: 100000 } });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }, { isCustom: true, customName: 'Fee', unitPrice: 20, qty: 1, taxCategory: 'exempt' }] });
    await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[1]._id), qty: 1 }] });
    await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 1 }] });
    const [c1, c2] = await cns(x.s.storeId);
    expect([c1.taxMinor, c1.totalMinor]).toEqual([0, 2000]);
    expect([c2.taxMinor, c2.totalMinor]).toEqual([100, 1100]);
  });

  it('the discount and a COUPON are shared out over the lines; returning one line credits its own share, the last return exactly closes the sale', async () => {
    const x = await fresh({ taxRate: 0.1 });
    await h.repos.posSettingsModel.collection.updateOne({ storeId: x.s.storeId }, { $set: { customItemApprovalAboveMinor: 100000 } });
    const c = await coupon(x.s, { discountValue: 20 });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }, { isCustom: true, customName: 'Setup', unitPrice: 30, qty: 1 }], couponCode: c.code });
    expect(a).toMatchObject({ subtotal: 40, discount: 8, tax: 3.2, total: 35.2 });
    const [tea, setup] = a.items;
    expect([tea.discountShareMinor, setup.discountShareMinor]).toEqual([200, 600]); // 20% of each line
    await refund(x, String(a._id), { items: [{ saleItemId: String(tea._id), qty: 1 }] });
    const n1 = (await cns(x.s.storeId))[0];
    expect([n1.grossMinor, n1.discountMinor, n1.netMinor, n1.taxMinor, n1.totalMinor]).toEqual([1000, 200, 800, 80, 880]);
    await refund(x, String(a._id));
    const all = await cns(x.s.storeId);
    expect(all.reduce((s2, k) => s2 + Number(k.totalMinor), 0)).toBe(3520);
    expect(((await h.repos.saleModel.findById(a._id).lean()) as any).status).toBe('refunded');
  });

  it('a return on a sale that predates G2.5 (no invoice, no stored breakdown) still works and the credit note equals what was paid out', async () => {
    const x = await fresh({ taxRate: 0.1 });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 3 }] });
    await h.repos.saleModel.collection.updateOne({ _id: new Types.ObjectId(String(a._id)) }, { $unset: { invoice: 1, 'items.0.netMinor': 1, 'items.0.taxMinor': 1, 'items.0.discountShareMinor': 1 } });
    const r: any = await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 1 }] });
    const note = (await cns(x.s.storeId))[0];
    expect(Number(note.totalMinor)).toBe(Math.round(r.data.refundedAmount * 100));
    expect(note.invoiceNumber).toBeNull();
  });
});

describe('refund method', () => {
  it('a cash refund needs an open shift; a card refund does not (it is recorded, unverified)', async () => {
    const x = await fresh();
    const cash = await sell(x);
    const card = await sell(x, { paymentMethod: 'card' });
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(x.sid) }, { $set: { status: 'closed', closedAt: new Date() } });
    expect(await code(refund(x, String(cash._id)))).toBe('OPEN_SHIFT_REQUIRED');
    expect(((await h.repos.saleModel.findById(cash._id).lean()) as any).status).toBe('completed'); // nothing happened
    const r: any = await refund(x, String(card._id));
    expect(r.data.tenders).toEqual([{ method: 'card', amount: 10 }]);
    expect(((await h.repos.posRefundModel.findOne({ saleId: String(card._id) }).lean()) as any).status).toBe('recorded_unverified');
    expect((await cns(x.s.storeId))[0].tenders).toEqual([{ method: 'card', amountMinor: 1000 }]);
  });

  it('a split sale is refunded to the same tenders in the documented order (card first, cash last) and the credit note says so', async () => {
    const x = await fresh();
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }], payments: [{ method: 'cash', amount: 12 }, { method: 'card', amount: 8, reference: 'AUTH1' }] });
    const r: any = await refund(x, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 1 }] });
    expect(r.data.tenders).toEqual([{ method: 'card', amount: 8 }, { method: 'cash', amount: 2 }]);
    expect((await cns(x.s.storeId))[0].tenders).toEqual([{ method: 'card', amountMinor: 800 }, { method: 'cash', amountMinor: 200 }]);
  });
});

describe('return approval', () => {
  const setPolicy = (x: X, p: any) => x.svc.updatePosSettings(x.s.sellerId, x.s.storeId, p);
  it('by default only a manager may return (as before G2.5); the message is unchanged', async () => {
    const x = await fresh(); const a = await sell(x);
    expect(await code(refund(x, String(a._id), {}, 'cashier'))).toBe('RETURN_NEEDS_MANAGER');
    expect(await msg(refund(x, String(a._id), {}, 'cashier'))).toBe('Only managers can issue refunds');
    expect(await reasons(refund(x, String(a._id), {}, 'cashier'))).toEqual(['store_requires_manager']);
    expect(await code(x.svc.refundSale(x.s.sellerId, String(a._id), {}, undefined))).toMatch(/PIN session is required/);
  });

  it('when the store allows it a cashier may return within every limit; each limit that is exceeded asks for a manager and says which', async () => {
    const x = await fresh();
    await setPolicy(x, { cashierReturnsEnabled: true, returnApprovalAboveMinor: 1500, returnApprovalAfterDays: 7 });
    const small = await sell(x);
    const r: any = await refund(x, String(small._id), {}, 'cashier');
    expect(r.data.creditNote.number).toBe('CN-000001');
    const note0 = (await cns(x.s.storeId))[0];
    expect([note0.approvedBy, note0.approvalReasons, note0.employeeId]).toEqual([null, [], x.s.cashierId]);

    const big = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }] });
    expect(await code(refund(x, String(big._id), {}, 'cashier'))).toBe('RETURN_NEEDS_MANAGER');
    expect(await reasons(refund(x, String(big._id), {}, 'cashier'))).toEqual(['amount_above_limit']);

    const old = await sell(x);
    await h.repos.saleModel.collection.updateOne({ _id: new Types.ObjectId(String(old._id)) }, { $set: { createdAt: new Date(Date.now() - 10 * 86_400_000) } });
    expect(await reasons(refund(x, String(old._id), {}, 'cashier'))).toEqual(['too_many_days_since_sale']);

    const noReceipt = await sell(x);
    expect(await reasons(refund(x, String(noReceipt._id), { receiptPresented: false }, 'cashier'))).toEqual(['no_original_receipt']);
    expect(((await h.repos.saleModel.findById(noReceipt._id).lean()) as any).status).toBe('completed'); // refused: nothing happened
  });

  it('a manager can approve what a cashier cannot; the credit note records who approved it and why it was needed', async () => {
    const x = await fresh();
    await setPolicy(x, { cashierReturnsEnabled: true, returnApprovalAboveMinor: 500, returnApprovalAfterDays: 7 });
    const a = await sell(x);
    await h.repos.saleModel.collection.updateOne({ _id: new Types.ObjectId(String(a._id)) }, { $set: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
    await refund(x, String(a._id), { receiptPresented: false }, 'manager');
    const note = (await cns(x.s.storeId))[0];
    expect(note.approvedBy).toBe(x.s.managerId);
    expect(note.approvalReasons.sort()).toEqual(['amount_above_limit', 'no_original_receipt', 'too_many_days_since_sale']);
    const audit: any = await h.repos.posAuditLogModel.findOne({ storeId: x.s.storeId, action: 'sale_refunded_full' }).lean();
    expect(audit.metadata).toMatchObject({ creditNote: note.number, approvedBy: x.s.managerId });
  });

  it('null limits mean "no limit"; the policy fields are validated and saved by the owner route', async () => {
    const x = await fresh();
    await setPolicy(x, { cashierReturnsEnabled: true, returnApprovalAboveMinor: null, returnApprovalAfterDays: null });
    const a = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 5 }] });
    await h.repos.saleModel.collection.updateOne({ _id: new Types.ObjectId(String(a._id)) }, { $set: { createdAt: new Date(Date.now() - 900 * 86_400_000) } });
    expect((await refund(x, String(a._id), {}, 'cashier')).success).toBe(true);
    const s: any = (await x.svc.getPosSettings(x.s.sellerId, x.s.storeId)).data;
    expect(s).toMatchObject({ cashierReturnsEnabled: true, returnApprovalAboveMinor: null, returnApprovalAfterDays: null });
  });
});

describe('a held sale keeps its coupon code', () => {
  it('the CODE is stored (upper-cased), nothing is discounted or counted; on resume the live check says whether it still works', async () => {
    const x = await fresh();
    const c = await coupon(x.s, { usageLimit: 5 });
    const held = await sell(x, { status: 'held', couponCode: c.code.toLowerCase() });
    expect(held).toMatchObject({ status: 'held', heldCouponCode: c.code, discount: 0, total: 10 });
    expect(((await h.repos.couponModel.findById(c._id).lean()) as any).usageCount ?? 0).toBe(0);
    const items = [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }];
    const q1: any = await x.svc.quoteSale(x.s.sellerId, { storeId: x.s.storeId, items, couponCode: held.heldCouponCode } as any);
    expect(q1.data).toMatchObject({ discount: 1, total: 9, coupon: { code: c.code } });
    // the coupon expires while the sale is on hold → the same check now refuses it with a clear code
    await h.repos.couponModel.updateOne({ _id: c._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await code(x.svc.quoteSale(x.s.sellerId, { storeId: x.s.storeId, items, couponCode: held.heldCouponCode } as any))).toBe('COUPON_EXPIRED');
    // and without the coupon the held sale completes at the full price
    const done: any = await x.svc.completeSale(x.s.sellerId, String(held._id), { paymentMethod: 'cash' } as any, tok(x.s, 'manager'));
    expect(done.data).toMatchObject({ total: 10, discount: 0, heldCouponCode: null });
  });

  it('completing with a still-valid code applies it and counts the use once; a refused code leaves the sale held', async () => {
    const x = await fresh();
    const c = await coupon(x.s, { usageLimit: 1 });
    const held = await sell(x, { status: 'held', couponCode: c.code });
    const done: any = await x.svc.completeSale(x.s.sellerId, String(held._id), { paymentMethod: 'cash', couponCode: c.code } as any, tok(x.s, 'manager'));
    expect(done.data).toMatchObject({ discount: 1, total: 9, couponCode: c.code, heldCouponCode: null });
    expect(((await h.repos.couponModel.findById(c._id).lean()) as any).usageCount).toBe(1);
    const held2 = await sell(x, { status: 'held', couponCode: c.code });
    expect(await code(x.svc.completeSale(x.s.sellerId, String(held2._id), { paymentMethod: 'cash', couponCode: c.code } as any, tok(x.s, 'manager')))).toBe('COUPON_LIMIT_REACHED');
    expect(((await h.repos.saleModel.findById(held2._id).lean()) as any).status).toBe('held');
    expect(await stockOf(h, x.s.variantId)).toBe(19); // 20 − the one sold; the failed completion gave its stock back
  });
});

describe('public tax invoice and credit-note pages', () => {
  async function app(svc: PosService) {
    const receipts = new PosReceiptService({ repositories: h.repos } as any, svc);
    const mod = await Test.createTestingModule({ controllers: [PublicReceiptController], providers: [{ provide: PosReceiptService, useValue: receipts }] }).compile();
    const a = mod.createNestApplication(); await a.init();
    return { receipts, a };
  }
  it('the invoice page shows the number, the seller as registered, per-line tax, totals, credit notes — and nothing about the customer', async () => {
    const x = await fresh({ taxRate: 0.1 }); const { receipts, a } = await app(x.svc);
    await x.svc.updatePosSettings(x.s.sellerId, x.s.storeId, { taxNtn: '1234567-8', taxLegalName: 'Test Traders Ltd', taxStrn: '3277876123456' } as any);
    await h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(x.s.variantId) }, { $set: { hsCode: '09024090' } });
    const sale = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }], customerName: 'Ayesha Khan', notes: '0300-1234567' });
    const token = (await receipts.getLink(x.s.sellerId, String(sale._id))).data.path.slice(3);
    const inv = await request(a.getHttpServer()).get(`/r/${token}/invoice`).expect(200);
    expect(inv.text).toContain('INV-000001');
    expect(inv.text).toContain('NTN 1234567-8');
    expect(inv.text).toContain('STRN 3277876123456');
    expect(inv.text).toContain('Test Traders Ltd');
    expect(inv.text).toContain('HS 09024090');
    expect(inv.text).toContain('Sales tax');
    expect(inv.text).not.toContain('Ayesha');
    expect(inv.text).not.toContain('0300');
    expect(inv.headers['cache-control']).toBe('no-store');
    expect(inv.headers['x-robots-tag']).toContain('noindex');

    await refund(x, String(sale._id), { items: [{ saleItemId: String(sale.items[0]._id), qty: 1 }] });
    const inv2 = await request(a.getHttpServer()).get(`/r/${token}/invoice`).expect(200);
    expect(inv2.text).toContain('CN-000001');
    const cn = await request(a.getHttpServer()).get(`/r/${token}/credit-note/CN-000001`).expect(200);
    expect(cn.text).toContain('Credit note');
    expect(cn.text).toContain('INV-000001');
    expect(cn.text).toContain('Tax reversed');
    expect(cn.text).not.toContain('Ayesha');
    await a.close();
  });

  it('unknown / malformed / revoked / other-sale tokens and numbers all give the same plain 404', async () => {
    const x = await fresh(); const { receipts, a } = await app(x.svc);
    const s1 = await sell(x); const s2 = await sell(x);
    const t1 = (await receipts.getLink(x.s.sellerId, String(s1._id))).data.path.slice(3);
    await refund(x, String(s2._id));
    const t2 = (await receipts.getLink(x.s.sellerId, String(s2._id))).data.path.slice(3);
    await request(a.getHttpServer()).get(`/r/${'A'.repeat(32)}/invoice`).expect(404);
    await request(a.getHttpServer()).get('/r/short/invoice').expect(404);
    await request(a.getHttpServer()).get(`/r/${t1}/credit-note/CN-000001`).expect(404); // that credit note belongs to another sale
    await request(a.getHttpServer()).get(`/r/${t2}/credit-note/CN-000001`).expect(200);
    await request(a.getHttpServer()).get(`/r/${t2}/credit-note/..%2F..%2Fetc`).expect(404);
    await request(a.getHttpServer()).get(`/r/${t2}/credit-note/CN-9`).expect(404);
    await receipts.revoke(x.s.sellerId, String(s2._id), x.s.managerId);
    await request(a.getHttpServer()).get(`/r/${t2}/invoice`).expect(404);
    await request(a.getHttpServer()).get(`/r/${t2}/credit-note/CN-000001`).expect(404);
    await a.close();
  });

  it('documentsOf: the invoice and every credit note for the till; another store\'s seller is refused', async () => {
    const x = await fresh(); const { receipts, a } = await app(x.svc);
    const s1 = await sell(x);
    await refund(x, String(s1._id), { items: [{ saleItemId: String(s1.items[0]._id), qty: 1 }] });
    const d: any = (await receipts.documentsOf(x.s.sellerId, String(s1._id))).data;
    expect(d.invoice.number).toBe('INV-000001');
    expect(d.creditNotes.map((c: any) => c.number)).toEqual(['CN-000001']);
    await expect(receipts.documentsOf(oidStr(), String(s1._id))).rejects.toBeDefined();
    await a.close();
  });
});
