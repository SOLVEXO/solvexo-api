/* eslint-disable prettier/prettier */
import { ForbiddenException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { PosService } from './pos.service';
import { runInDeviceScope } from './pos-device-scope';
import { backfillDown, backfillUp } from '../scripts/pos-g1a-backfill.lib';
import { MongoHarness, oidStr, seedStore, startMongoHarness, stockOf } from './testing/mongo-harness';

/**
 * G1a on a REAL replica-set MongoDB: every payment and refund has its own record; audit is written in the same
 * transaction as the business write (and is append-only); held-sale delete is a soft delete with a reason; shift close
 * reconciles the card total; the backfill is dry-runnable and reversible. Old-build payloads (no new fields) keep working.
 */
jest.setTimeout(120_000);

let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); jest.restoreAllMocks(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tokenFor = (s: Seed, who: 'manager' | 'cashier') =>
  jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });

async function openSession(svc: PosService, s: Seed, over: any = {}) {
  const res: any = await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 0, ...over } as any);
  return String(res.data._id);
}
const saleDto = (s: Seed, sessionId: string, over: any = {}) => ({
  storeId: s.storeId, sessionId, registerId: s.registerId, employeeId: s.cashierId,
  items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], paymentMethod: 'cash', ...over,
});
const payments = (storeId: string) => h.repos.posPaymentModel.find({ storeId }).sort({ _id: 1 }).lean();
const audits = (storeId: string, action?: string) => h.repos.posAuditLogModel.find({ storeId, ...(action ? { action } : {}) }).lean();
const errCode = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

describe('payment records', () => {
  it('cash → confirmed; card / other → recorded_unverified; split → one row per tender, with server-derived context', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 20, price: 10 });
    const sid = await openSession(svc, s, { shiftId: 'shift-7' });
    const cash: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    const split: any = await runInDeviceScope({ storeId: s.storeId, deviceId: 'dev-A' }, () =>
      svc.createSale(s.sellerId, saleDto(s, sid, { payments: [{ method: 'card', amount: 12, reference: 'AUTH-9' }, { method: 'cash', amount: 8 }], deviceId: 'SPOOFED', shiftId: 'SPOOFED' }) as any, undefined));
    const rows: any[] = await payments(s.storeId);
    expect(rows.map((r) => [r.saleId, r.lineNo, r.tender, r.amount, r.status])).toEqual([
      [String(cash.data._id), 0, 'cash', 20, 'confirmed'],
      [String(split.data._id), 0, 'card', 12, 'recorded_unverified'],
      [String(split.data._id), 1, 'cash', 8, 'confirmed'],
    ]);
    const card = rows[1];
    expect(card.reference).toBe('AUTH-9');
    expect(card.confirmationSource).toBeNull();
    expect(card).toMatchObject({ storeId: s.storeId, registerId: s.registerId, sessionId: sid, shiftId: 'shift-7', employeeId: s.cashierId, deviceId: 'dev-A', currency: 'USD', currencyExponent: 2 });
    // the sale itself carries shift + device, taken from the session / token — a spoofed body value is ignored
    const sale: any = await h.repos.saleModel.findById(split.data._id).lean();
    expect(sale.shiftId).toBe('shift-7'); expect(sale.deviceId).toBe('dev-A');
    expect(cash.data.payments).toHaveLength(1); // the embedded array old app builds read is still there
  });

  it('a retry with the same idempotency key creates ONE sale and ONE payment row; stock taken once', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const dto = saleDto(s, sid, { idempotencyKey: 'k-1' }) as any;
    const a: any = await svc.createSale(s.sellerId, dto, undefined);
    const b: any = await svc.createSale(s.sellerId, dto, undefined);
    expect(String(b.data._id)).toBe(String(a.data._id));
    expect(await payments(s.storeId)).toHaveLength(1);
    expect(await stockOf(h, s.variantId)).toBe(8);
    // concurrent duplicates too
    const dto2 = saleDto(s, sid, { idempotencyKey: 'k-2' }) as any;
    await Promise.allSettled(Array.from({ length: 5 }, () => svc.createSale(s.sellerId, dto2, undefined)));
    expect(await h.repos.saleModel.countDocuments({ idempotencyKey: 'k-2' })).toBe(1);
    expect(await h.repos.posPaymentModel.countDocuments({ idempotencyKey: 'k-2' })).toBe(1);
  });

  it('the database itself refuses a second payment row for the same sale line or the same key+line', async () => {
    const svc = makeService(); const s = await seedStore(h);
    const sid = await openSession(svc, s);
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid, { idempotencyKey: 'k-3' }) as any, undefined);
    const [row]: any[] = await payments(s.storeId);
    const { _id, ...copy } = row;
    await expect(h.repos.posPaymentModel.create({ ...copy })).rejects.toMatchObject({ code: 11000 });
    await expect(h.repos.posPaymentModel.create({ ...copy, saleId: 'other-sale' })).rejects.toMatchObject({ code: 11000 }); // same (store,key,line)
    expect(String(sale.data._id)).toBeTruthy();
  });

  it('an old app build (no key, no new fields, no employee token) still sells', async () => {
    const svc = makeService(); const s = await seedStore(h);
    const sid = await openSession(svc, s);
    const res: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    expect(res.success).toBe(true);
    const [row]: any[] = await payments(s.storeId);
    expect(row.idempotencyKey).toBeUndefined();
    expect(row.deviceId).toBeNull();
  });

  it('completing a held sale records its payments once; a second complete attempt creates nothing', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const held: any = await svc.createSale(s.sellerId, saleDto(s, sid, { status: 'held' }) as any, undefined);
    expect(await payments(s.storeId)).toHaveLength(0);
    const done: any = await svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'card', paymentReference: 'A1' } as any, undefined);
    expect(done.data.status).toBe('completed');
    expect(await payments(s.storeId)).toHaveLength(1);
    expect(await errCode(svc.completeSale(s.sellerId, String(held.data._id), { paymentMethod: 'card' } as any, undefined))).toBe('Only held sales can be completed');
    expect(await payments(s.storeId)).toHaveLength(1);
    expect(await stockOf(h, s.variantId)).toBe(8);
  });
});

describe('refund records', () => {
  it('a refund gets its own record + reference, linked from the sale; a retry with the same key returns the same refund', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s, { shiftId: 'shift-1' });
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid, { payments: [{ method: 'card', amount: 20, reference: 'A' }] }) as any, undefined);
    const saleId = String(sale.data._id);
    const first: any = await runInDeviceScope({ storeId: s.storeId, deviceId: 'dev-B' }, () => svc.refundSale(s.sellerId, saleId, { reason: 'wrong item' } as any, tokenFor(s, 'manager'), 'rk-1'));
    const retry: any = await svc.refundSale(s.sellerId, saleId, { reason: 'wrong item' } as any, tokenFor(s, 'manager'), 'rk-1');
    expect(retry.data.replayed).toBe(true);
    expect(retry.data.refundId).toBe(first.data.refundId);
    const refunds: any[] = await h.repos.posRefundModel.find({ storeId: s.storeId }).lean();
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ seq: 0, kind: 'full', amount: 20, reason: 'wrong item', status: 'recorded_unverified', confirmationSource: null, deviceId: 'dev-B', employeeId: s.managerId, saleSessionId: sid, shiftId: 'shift-1', idempotencyKey: 'rk-1' });
    expect(refunds[0].reference).toBe(`${sale.data.saleNumber}-R1`);
    const after: any = await h.repos.saleModel.findById(saleId).lean();
    expect(after.refundedAmount).toBe(20);
    expect(after.refunds[0].refundId).toBe(String(refunds[0]._id));
    expect(await stockOf(h, s.variantId)).toBe(10); // restored once
    expect((await audits(s.storeId, 'sale_refunded_full')).length).toBe(1);
  });

  it('two concurrent refunds (different keys, no key) → exactly one refund record', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    const saleId = String(sale.data._id);
    const res = await Promise.allSettled([
      svc.refundSale(s.sellerId, saleId, undefined, tokenFor(s, 'manager'), 'x'),
      svc.refundSale(s.sellerId, saleId, undefined, tokenFor(s, 'manager'), 'y'),
      svc.refundSale(s.sellerId, saleId, undefined, tokenFor(s, 'manager')),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.repos.posRefundModel.countDocuments({ storeId: s.storeId })).toBe(1);
  });

  it('a refund made in a LATER shift is attributed to that shift (not the sale\'s)', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid1 = await openSession(svc, s, { shiftId: 'shift-1' });
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid1) as any, undefined);
    await svc.closeSession(s.sellerId, { sessionId: sid1, closingCash: 20 } as any);
    const sid2 = await openSession(svc, s, { shiftId: 'shift-2' });
    await svc.refundSale(s.sellerId, String(sale.data._id), undefined, tokenFor(s, 'manager'));
    const [r]: any[] = await h.repos.posRefundModel.find({ storeId: s.storeId }).lean();
    expect(r).toMatchObject({ sessionId: sid2, shiftId: 'shift-2', saleSessionId: sid1 });
  });

  it('a refund without a key or reason (old build) works', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    const res: any = await svc.refundSale(s.sellerId, String(sale.data._id), undefined, tokenFor(s, 'manager'));
    expect(res.success).toBe(true);
    const [r]: any[] = await h.repos.posRefundModel.find({ storeId: s.storeId }).lean();
    expect(r.idempotencyKey).toBeUndefined(); expect(r.reason).toBeNull(); expect(r.status).toBe('confirmed'); // cash refund
  });
});

describe('durable audit', () => {
  it('the audit event commits WITH the sale: when the audit write fails, nothing is persisted and the stock comes back', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    jest.spyOn(h.repos.posAuditLogModel, 'create').mockRejectedValueOnce(new Error('audit store down'));
    await expect(svc.createSale(s.sellerId, saleDto(s, sid, { idempotencyKey: 'k-fail' }) as any, undefined)).rejects.toThrow('audit store down');
    expect(await h.repos.saleModel.countDocuments({ storeId: s.storeId })).toBe(0);
    expect(await h.repos.posPaymentModel.countDocuments({ storeId: s.storeId })).toBe(0);
    expect(await stockOf(h, s.variantId)).toBe(10);
    // …and a retry once audit is back succeeds, exactly once
    const ok: any = await svc.createSale(s.sellerId, saleDto(s, sid, { idempotencyKey: 'k-fail' }) as any, undefined);
    expect(ok.success).toBe(true);
    expect(await h.repos.saleModel.countDocuments({ storeId: s.storeId })).toBe(1);
    expect((await audits(s.storeId, 'sale_created')).length).toBe(1);
  });

  it('a failing audit write rolls back a refund (no refund record, sale unchanged) and a void', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const a: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    const b: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    jest.spyOn(h.repos.posAuditLogModel, 'create').mockRejectedValue(new Error('audit store down'));
    await expect(svc.refundSale(s.sellerId, String(a.data._id), undefined, tokenFor(s, 'manager'), 'rk')).rejects.toThrow('audit store down');
    await expect(svc.voidSale(s.sellerId, String(b.data._id), { reason: 'x' }, tokenFor(s, 'manager'))).rejects.toThrow('audit store down');
    jest.restoreAllMocks();
    expect(await h.repos.posRefundModel.countDocuments({ storeId: s.storeId })).toBe(0);
    expect((await h.repos.saleModel.findById(a.data._id).lean() as any).status).toBe('completed');
    expect((await h.repos.saleModel.findById(b.data._id).lean() as any).status).toBe('completed');
  });

  it('audit events carry session / register / shift / device and are append-only (no update or delete path)', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s, { shiftId: 'shift-3' });
    await runInDeviceScope({ storeId: s.storeId, deviceId: 'dev-C' }, () => svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined));
    const [ev]: any[] = await audits(s.storeId, 'sale_created');
    expect(ev).toMatchObject({ sessionId: sid, registerId: s.registerId, shiftId: 'shift-3', deviceId: 'dev-C', employeeId: s.cashierId });
    const A = h.repos.posAuditLogModel;
    await expect(A.updateOne({ _id: ev._id }, { $set: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(A.findOneAndUpdate({ _id: ev._id }, { $set: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(A.updateMany({}, { $set: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(A.deleteOne({ _id: ev._id })).rejects.toThrow(/append-only/);
    await expect(A.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(A.findOneAndDelete({ _id: ev._id })).rejects.toThrow(/append-only/);
    await expect(A.replaceOne({ _id: ev._id }, { storeId: 'x', action: 'y' })).rejects.toThrow(/append-only/);
    const doc: any = await A.findById(ev._id); doc.action = 'tampered';
    await expect(doc.save()).rejects.toThrow(/append-only/);
    expect(((await A.findById(ev._id).lean()) as any).action).toBe('sale_created');
  });

  it('payment and refund records are fully immutable — a payment\'s lifecycle lives in payment_events (G2.1), so even its status fields cannot be set', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid, { payments: [{ method: 'card', amount: 20 }] }) as any, undefined);
    await svc.refundSale(s.sellerId, String(sale.data._id), undefined, tokenFor(s, 'manager'));
    const P = h.repos.posPaymentModel; const R = h.repos.posRefundModel;
    await expect(P.updateOne({}, { $set: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(P.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(R.updateOne({}, { $set: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(R.deleteMany({})).rejects.toThrow(/append-only/);
    // G2.1: the G1a allowSetFields hook is gone — status moves only by appending a payment event, never by updating the row
    await expect(P.updateOne({}, { $set: { status: 'confirmed', confirmationSource: 'terminal', confirmedAt: new Date() } })).rejects.toThrow(/append-only/);
    expect(((await P.findOne({}).lean()) as any)).toMatchObject({ status: 'recorded_unverified', confirmationSource: null, amount: 20 });
  });
});

describe('held-sale delete (soft)', () => {
  const held = async (svc: PosService, s: Seed, sid: string) => String(((await svc.createSale(s.sellerId, saleDto(s, sid, { status: 'held' }) as any, undefined)) as any).data._id);

  it('keeps the row (status discarded, who/when/why), writes an audit event, hides it from every list, and cannot be completed', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const id = await held(svc, s, sid);
    const res: any = await svc.discardHeldSale(s.sellerId, id, { reason: 'customer left', employeeToken: tokenFor(s, 'cashier') });
    expect(res.success).toBe(true);
    const row: any = await h.repos.saleModel.findById(id).lean();
    expect(row).toMatchObject({ status: 'discarded', deletedBy: s.cashierId, deleteReason: 'customer left' });
    expect(row.deletedAt).toBeInstanceOf(Date);
    const [ev]: any[] = await audits(s.storeId, 'held_sale_discarded');
    expect(ev).toMatchObject({ targetId: id, sessionId: sid });
    expect(ev.metadata).toMatchObject({ reason: 'customer left', saleNumber: row.saleNumber });
    expect((await svc.getHeldSales(s.sellerId, s.storeId) as any).data).toHaveLength(0);
    expect(((await svc.getSales(s.sellerId, { storeId: s.storeId }) as any).data.sales as any[]).filter((x: any) => String(x._id) === id)).toHaveLength(0);
    expect(await errCode(svc.completeSale(s.sellerId, id, { paymentMethod: 'cash' } as any, undefined))).toBeTruthy();
    expect(await stockOf(h, s.variantId)).toBe(10); // a held sale never took stock
  });

  it('retry is idempotent (one audit event), an old build sends no reason ("not provided"), a completed sale cannot be discarded', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const id = await held(svc, s, sid);
    await svc.discardHeldSale(s.sellerId, id); // old build: no reason, no employee token
    const again: any = await svc.discardHeldSale(s.sellerId, id, { reason: 'later retry' });
    expect(again.data.alreadyDiscarded).toBe(true);
    expect((await h.repos.saleModel.findById(id).lean() as any)).toMatchObject({ deleteReason: 'not provided', deletedBy: s.sellerId });
    expect(await audits(s.storeId, 'held_sale_discarded')).toHaveLength(1);
    const real: any = await svc.createSale(s.sellerId, saleDto(s, sid) as any, undefined);
    await expect(svc.discardHeldSale(s.sellerId, String(real.data._id), { reason: 'x' })).rejects.toThrow(/Only held sales/);
  });

  it('racing a completion: exactly one wins (a sale never both completes and gets discarded)', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const id = await held(svc, s, sid);
    const res = await Promise.allSettled([
      svc.completeSale(s.sellerId, id, { paymentMethod: 'cash' } as any, undefined),
      svc.discardHeldSale(s.sellerId, id, { reason: 'race' }),
    ]);
    const final: any = await h.repos.saleModel.findById(id).lean();
    expect(['completed', 'discarded']).toContain(final.status);
    if (final.status === 'completed') expect(await stockOf(h, s.variantId)).toBe(8); else expect(await stockOf(h, s.variantId)).toBe(10);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
  });
});

describe('card reconciliation at shift close', () => {
  async function shiftWithCard(svc: PosService, s: Seed) {
    const sid = await openSession(svc, s);
    await svc.createSale(s.sellerId, saleDto(s, sid, { payments: [{ method: 'card', amount: 12, reference: 'A' }, { method: 'cash', amount: 8 }] }) as any, undefined);
    return sid;
  }

  it('no slip total (old build) → closes as before, marked not_reconciled', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await shiftWithCard(svc, s);
    const res: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 8 } as any);
    expect(res.data.status).toBe('closed');
    expect(res.data.cardReconciliation).toMatchObject({ status: 'not_reconciled', slipTotal: null, expectedCard: 12, variance: null });
  });

  it('a slip total that matches → matched, no manager needed', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await shiftWithCard(svc, s);
    const res: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 8, cardTotalFromSlip: 12 } as any, tokenFor(s, 'cashier'));
    expect(res.data.cardReconciliation).toMatchObject({ status: 'matched', slipTotal: 12, variance: 0 });
    expect(await audits(s.storeId, 'card_variance_approved')).toHaveLength(0);
  });

  it('a mismatch is NOT closed without a manager PIN session; the error says why', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await shiftWithCard(svc, s);
    for (const token of [undefined, tokenFor(s, 'cashier')]) {
      let err: any; try { await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 8, cardTotalFromSlip: 10 } as any, token); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: 'CARD_VARIANCE_APPROVAL_REQUIRED', slipTotal: 10, expectedCard: 12, variance: -2 });
    }
    expect(((await h.repos.registerSessionModel.findById(sid).lean()) as any).status).toBe('open');
  });

  it('a manager approves the mismatch → closed, variance stored, two audit events (close + approval)', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await shiftWithCard(svc, s);
    const res: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 8, cardTotalFromSlip: 10 } as any, tokenFor(s, 'manager'));
    expect(res.data.status).toBe('closed');
    expect(res.data.cardReconciliation).toMatchObject({ status: 'variance_approved', slipTotal: 10, expectedCard: 12, variance: -2, approvedBy: s.managerId });
    const [ap]: any[] = await audits(s.storeId, 'card_variance_approved');
    expect(ap).toMatchObject({ employeeId: s.managerId, targetId: sid });
    expect(ap.metadata).toMatchObject({ variance: -2, cashierId: s.cashierId });
    const [closed]: any[] = await audits(s.storeId, 'session_closed');
    expect(closed.metadata.cardReconciliation).toMatchObject({ status: 'variance_approved', variance: -2 });
  });

  it('expected card is net of card refunds', async () => {
    const svc = makeService(); const s = await seedStore(h, { stock: 10 });
    const sid = await openSession(svc, s);
    const sale: any = await svc.createSale(s.sellerId, saleDto(s, sid, { payments: [{ method: 'card', amount: 20 }] }) as any, undefined);
    await svc.refundSale(s.sellerId, String(sale.data._id), undefined, tokenFor(s, 'manager'));
    const res: any = await svc.closeSession(s.sellerId, { sessionId: sid, closingCash: 0, cardTotalFromSlip: 0 } as any);
    expect(res.data.cardReconciliation).toMatchObject({ status: 'matched', expectedCard: 0 });
  });
});

describe('backfill (dry-run, up, down)', () => {
  async function legacy(s: Seed) {
    const sid = oidStr();
    const mk = (n: string, extra: any) => ({
      saleNumber: n, storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [], subtotal: 20, discount: 0, tax: 0, total: 20,
      currency: 'USD', currencyExponent: 2, status: 'completed', createdAt: new Date('2026-01-01'), ...extra,
    });
    await h.repos.registerSessionModel.collection.insertOne({ _id: new (require('mongoose').Types.ObjectId)(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, shiftId: 'old-shift', openedAt: new Date(), status: 'closed' } as any);
    await h.repos.saleModel.collection.insertMany([
      mk('L-1', { paymentMethod: 'cash' }),                                                    // legacy: no payments[]
      mk('L-2', { paymentMethod: 'card', payments: [{ method: 'card', amount: 12, reference: 'Z' }, { method: 'cash', amount: 8 }], idempotencyKey: 'legacy-key' }),
      mk('L-3', { paymentMethod: 'card', status: 'partially_refunded', refundedAmount: 5, payments: [{ method: 'card', amount: 20 }], refunds: [{ amount: 5, kind: 'partial', tenders: [{ method: 'card', amount: 5 }], items: [], employeeId: s.managerId, createdAt: new Date('2026-01-02') }] }),
      mk('H-1', { paymentMethod: 'cash', status: 'held' }),                                    // held: no payments yet
    ] as any);
  }

  it('dry run writes nothing; up creates exactly the missing records; a second up is a no-op; down removes only what up made', async () => {
    const s = await seedStore(h);
    await legacy(s);
    const db = h.conn.db!;
    const names = { pays: h.repos.posPaymentModel.collection.collectionName, refs: h.repos.posRefundModel.collection.collectionName };
    expect(names).toEqual({ pays: 'pospayments', refs: 'posrefunds' }); // the lib's collection names

    const dry = await backfillUp(db, { dryRun: true });
    expect(dry).toMatchObject({ salesScanned: 3, paymentsExpected: 4, paymentsBefore: 0, paymentsToInsert: 4, refundsExpected: 1, refundsToInsert: 1, shiftIdsToSet: 3 });
    expect(await h.repos.posPaymentModel.countDocuments({})).toBe(0);
    expect(await h.repos.posRefundModel.countDocuments({})).toBe(0);
    expect(await h.repos.saleModel.countDocuments({ shiftId: 'old-shift' })).toBe(0);

    const up = await backfillUp(db, { dryRun: false });
    expect(up.paymentsToInsert).toBe(4);
    const pays: any[] = await h.repos.posPaymentModel.find({}).sort({ saleNumber: 1, lineNo: 1 }).lean();
    expect(pays.map((p) => [p.saleNumber, p.lineNo, p.tender, p.status, p.backfilled])).toEqual([
      ['L-1', 0, 'cash', 'confirmed', true], ['L-2', 0, 'card', 'recorded_unverified', true], ['L-2', 1, 'cash', 'confirmed', true], ['L-3', 0, 'card', 'recorded_unverified', true],
    ]);
    expect(pays.find((p) => p.saleNumber === 'L-2' && p.lineNo === 0).idempotencyKey).toBe('legacy-key');
    const [rf]: any[] = await h.repos.posRefundModel.find({}).lean();
    expect(rf).toMatchObject({ saleNumber: 'L-3', seq: 0, amount: 5, reference: 'L-3-R1', status: 'recorded_unverified', backfilled: true });
    const l3: any = await h.repos.saleModel.findOne({ saleNumber: 'L-3' }).lean();
    expect(l3.refunds[0].refundId).toBe(String(rf._id)); expect(l3.shiftId).toBe('old-shift');

    const again = await backfillUp(db, { dryRun: false });
    expect(again).toMatchObject({ paymentsToInsert: 0, refundsToInsert: 0 });
    expect(await h.repos.posPaymentModel.countDocuments({})).toBe(4);

    // a live (non-backfilled) record must survive the rollback
    const svc = makeService(); const sid = await openSession(svc, s);
    await svc.createSale(s.sellerId, saleDto(s, sid, { idempotencyKey: 'live' }) as any, undefined);
    const downDry = await backfillDown(db, { dryRun: true });
    expect(downDry).toMatchObject({ paymentsRemoved: 4, refundsRemoved: 1 });
    expect(await h.repos.posPaymentModel.countDocuments({})).toBe(5);
    await backfillDown(db, { dryRun: false });
    expect(await h.repos.posPaymentModel.countDocuments({})).toBe(1);
    expect(await h.repos.posPaymentModel.countDocuments({ idempotencyKey: 'live' })).toBe(1);
    expect(await h.repos.posRefundModel.countDocuments({})).toBe(0);
    const l3b: any = await h.repos.saleModel.findOne({ saleNumber: 'L-3' }).lean();
    expect(l3b.refunds[0].refundId).toBeUndefined(); expect(l3b.shiftId).toBeUndefined();
  });
});
