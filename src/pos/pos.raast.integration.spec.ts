/* eslint-disable prettier/prettier */
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { fixtureFactory } from '../payments-core/testing/payments-harness';
import { stockOf } from './testing/mongo-harness';

/**
 * G2.3 on a real replica-set MongoDB, mock provider: a sale with a Raast QR line completes ONLY when that payment is CONFIRMED, and a
 * confirmed payment belongs to exactly one sale (race-safe). Price 10 × qty 2 = 20.00 PKR = 2000 minor units.
 */
jest.setTimeout(180_000);
process.env.JWT_SECRET = 'test-secret';

const f = fixtureFactory();
beforeAll(f.start); afterAll(f.stop);
type X = Awaited<ReturnType<typeof f.fresh>>;

const svcFor = (x: X) => new PosService({ repositories: x.h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any, undefined, x.core);
const mgr = (x: X) => jwt.sign({ employeeId: x.s.managerId, storeId: x.s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
let n = 0;
const dto = (x: X, over: any = {}) => ({
  storeId: x.s.storeId, sessionId: x.sessionId, registerId: x.s.registerId, employeeId: x.s.cashierId,
  items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }], idempotencyKey: `sale-${++n}`, paymentMethod: 'raast_qr', ...over,
});
const qrLine = (intentId: string, amount = 20) => ({ method: 'raast_qr', amount, intentId });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
/** A paid QR payment of `amountMinor`, ready to settle a sale. */
async function paid(x: X, amountMinor = 2000, extra: any = {}) { const v = await x.create(extra, amountMinor); await x.send('confirmed', v.id); return v; }

describe('the sale completes only with a CONFIRMED payment', () => {
  it('confirmed QR payment → sale completed, payment attached, drawer counters and stock updated; the payment is consumed', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x);
    const res: any = await svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined);
    expect(res.data).toMatchObject({ status: 'completed', paymentMethod: 'raast_qr', total: 20 });
    expect(res.data.payments[0]).toMatchObject({ method: 'raast_qr', amount: 20, amountMinor: 2000, intentId: v.id });
    expect(res.data.payments[0].reference).toBeTruthy(); // the provider's reference
    const row: any = await x.h.repos.posPaymentModel.findOne({ saleId: String(res.data._id) }).lean();
    expect(row).toMatchObject({ tender: 'raast_qr', status: 'confirmed', confirmationSource: 'raast', paymentIntentId: v.id, amountMinor: 2000 });
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed', 'consumed']);
    const session: any = await x.h.repos.registerSessionModel.findById(x.sessionId).lean();
    expect(session).toMatchObject({ digitalSales: 20, digitalSalesMinor: 2000, totalSales: 20 });
    expect(session.cashSales ?? 0).toBe(0);
    expect(await stockOf(x.h, x.s.variantId)).toBe(3);
    expect((await x.core.getIntent(x.s.storeId, v.id))).toMatchObject({ consumed: true, saleId: String(res.data._id) });
  });

  it('any status other than confirmed is refused — created, failed, expired, cancelled — and nothing is sold or taken from stock', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const open = await x.create({}, 2000);
    const failed = await x.create({}, 2000); await x.send('failed', failed.id);
    const expired = await x.create({}, 2000); await x.core.expireIfDue(await x.intents.findById(expired.id).lean(), new Date(Date.now() + 400_000));
    const cancelled = await x.create({}, 2000); await x.core.cancel(x.s.storeId, cancelled.id);
    for (const v of [open, failed, expired, cancelled]) expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined))).toBe('PAYMENT_NOT_CONFIRMED');
    expect(await x.h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(0);
    expect(await stockOf(x.h, x.s.variantId)).toBe(5);
    expect((await x.eventTypes(open.id))).toEqual(['created']);
  });

  it('LATE confirmation after cancel: it shows in Needs attention, and the cashier ringing the sale up with it clears the item', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await x.create({ saleAttemptKey: 'attempt-late' }, 2000);
    await x.core.cancel(x.s.storeId, v.id);
    await x.send('confirmed', v.id);
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toEqual(['paid_after_expiry']);
    const res: any = await svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined);
    expect(res.data.status).toBe('completed');
    expect((await x.core.listAttention(x.s.storeId)).items).toEqual([]);
  });

  it('a DUPLICATE webhook changes nothing: one confirmed event, one sale', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await x.create({}, 2000);
    await x.send('confirmed', v.id); await x.send('confirmed', v.id, { eventId: 'same' }); await x.send('confirmed', v.id, { eventId: 'same' });
    expect((await x.eventTypes(v.id)).filter((t) => t === 'confirmed')).toHaveLength(1);
    await svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined);
    expect(await x.h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(1);
  });

  it('AMOUNT MISMATCH from the provider never confirms; the till is refused; a manager sends back what was received', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await x.create({}, 2000);
    x.mock.simulate(await x.providerRefOf(v.id), 'confirm');
    await x.send('confirmed', v.id, { amountMinor: 1500 }); // the customer paid 15.00 instead of 20.00
    expect(await x.eventTypes(v.id)).toEqual(['created', 'anomaly']);
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined))).toBe('PAYMENT_NOT_CONFIRMED');
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toEqual(['anomaly']);
    const r = await x.core.reconcile(x.s.storeId, v.id, x.manager, { resolution: 'refund', note: 'customer paid the wrong amount' });
    expect(r).toMatchObject({ refundedMinor: 1500, attention: [] });
    expect(await x.h.repos.posAuditLogModel.countDocuments({ storeId: x.s.storeId, action: 'payment_reconciled' })).toBe(1);
  });

  it('the line must match the payment: amount, shift, currency; the payment id is required; QR is not available as a legacy single payment, offline or on a held sale', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x);
    const short = await paid(x, 1500); // the customer really paid 15.00, the sale is 20.00
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(short.id, 20)] }) as any, undefined))).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [{ method: 'raast_qr', amount: 20 }] }) as any, undefined))).toBe('PAYMENT_INTENT_REQUIRED');
    expect(await code(svc.createSale(x.s.sellerId, dto(x) as any, undefined))).toBe('QR_REQUIRES_PAYMENT_LINES');
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(String(new Types.ObjectId()))] }) as any, undefined))).toBe('PAYMENT_NOT_FOUND');
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { status: 'held', payments: [qrLine(v.id)] }) as any, undefined))).toBe('DIGITAL_PAYMENT_ON_HELD_SALE');
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { offline: true, clientCreatedAt: new Date().toISOString(), payments: [qrLine(v.id)] }) as any, undefined))).toBe('DIGITAL_PAYMENT_ONLINE_ONLY');
    // another shift
    const other = String(new Types.ObjectId());
    await x.h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(other), storeId: x.s.storeId, registerId: String(new Types.ObjectId()), status: 'open', openedAt: new Date() });
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { sessionId: other, payments: [qrLine(v.id)] }) as any, undefined))).toBe('PAYMENT_SESSION_MISMATCH');
    // currency: the sale is in PKR, the payment says USD
    await x.intents.collection.updateOne({ _id: new Types.ObjectId(v.id) }, { $set: { currency: 'USD' } });
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined))).toBe('PAYMENT_CURRENCY_MISMATCH');
    expect(await x.h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(0);
    expect(await stockOf(x.h, x.s.variantId)).toBe(5);
  });
});

describe('a confirmed payment belongs to exactly ONE sale', () => {
  it('two tills try to attach the same payment at once: one sale is made, the other is refused PAYMENT_ALREADY_USED, stock is taken once', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x);
    const results = await Promise.allSettled([
      svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined),
      svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined),
    ]); // two tills (stock 5 covers both reservations, so the ONLY thing that can refuse the second is the payment itself)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const codes = results.filter((r) => r.status === 'rejected').map((r: any) => r.reason?.response?.code);
    expect(codes.every((c) => c === 'PAYMENT_ALREADY_USED' || c === 'PAYMENT_BUSY')).toBe(true);
    expect(await x.h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(1);
    expect((await x.eventTypes(v.id)).filter((t) => t === 'consumed')).toHaveLength(1);
    expect(await stockOf(x.h, x.s.variantId)).toBe(3);
    expect(await x.h.repos.posPaymentModel.countDocuments({ storeId: x.s.storeId, tender: 'raast_qr' })).toBe(1);
  });

  it('the SAME request retried (same idempotency key, even concurrently) returns the original sale and consumes the payment once', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x);
    const body = dto(x, { idempotencyKey: 'retry-me', payments: [qrLine(v.id)] });
    const [a, b]: any[] = await Promise.all([svc.createSale(x.s.sellerId, body as any, undefined), svc.createSale(x.s.sellerId, body as any, undefined).catch((e) => e)]);
    const ok = [a, b].filter((r) => r?.data?._id);
    expect(new Set(ok.map((r) => String(r.data._id))).size).toBe(1);
    const later: any = await svc.createSale(x.s.sellerId, body as any, undefined);
    expect(String(later.data._id)).toBe(String(ok[0].data._id));
    expect(await x.h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(1);
    expect((await x.eventTypes(v.id)).filter((t) => t === 'consumed')).toHaveLength(1);
    expect(await stockOf(x.h, x.s.variantId)).toBe(3);
  });

  it('a held sale completed with a QR payment uses the same rules (and a refused payment gives its stock back)', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const held: any = await svc.createSale(x.s.sellerId, dto(x, { status: 'held', paymentMethod: 'cash' }) as any, undefined);
    const v = await x.create({}, 2000);
    expect(await code(svc.completeSale(x.s.sellerId, String(held.data._id), { payments: [qrLine(v.id)], paymentMethod: 'raast_qr' } as any, undefined))).toBe('PAYMENT_NOT_CONFIRMED');
    expect(await stockOf(x.h, x.s.variantId)).toBe(5);
    await x.send('confirmed', v.id);
    const done: any = await svc.completeSale(x.s.sellerId, String(held.data._id), { payments: [qrLine(v.id)], paymentMethod: 'raast_qr' } as any, undefined);
    expect(done.data).toMatchObject({ status: 'completed', paymentMethod: 'raast_qr' });
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed', 'consumed']);
    expect(await stockOf(x.h, x.s.variantId)).toBe(3);
    // the payment cannot settle a second held sale
    const held2: any = await svc.createSale(x.s.sellerId, dto(x, { status: 'held', paymentMethod: 'cash' }) as any, undefined);
    expect(await code(svc.completeSale(x.s.sellerId, String(held2.data._id), { payments: [qrLine(v.id)], paymentMethod: 'raast_qr' } as any, undefined))).toBe('PAYMENT_ALREADY_USED');
    expect(await stockOf(x.h, x.s.variantId)).toBe(3);
  });
});

describe('split tender with a QR line', () => {
  it('card 8.00 + QR 12.00: every QR line must be confirmed first; then the sale is a split with both lines', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await x.create({}, 1200);
    const body = (id: string) => dto(x, { paymentMethod: 'card', payments: [{ method: 'card', amount: 8 }, qrLine(id, 12)] });
    expect(await code(svc.createSale(x.s.sellerId, body(v.id) as any, undefined))).toBe('PAYMENT_NOT_CONFIRMED');
    expect(await x.h.repos.saleModel.countDocuments({ storeId: x.s.storeId })).toBe(0);
    await x.send('confirmed', v.id);
    const res: any = await svc.createSale(x.s.sellerId, body(v.id) as any, undefined);
    expect(res.data).toMatchObject({ status: 'completed', paymentMethod: 'split' });
    expect(res.data.payments.map((p: any) => p.method)).toEqual(['card', 'raast_qr']);
    const session: any = await x.h.repos.registerSessionModel.findById(x.sessionId).lean();
    expect(session).toMatchObject({ cardSales: 8, digitalSales: 12 });
  });

  it('two QR lines: each needs its own confirmed payment; one unconfirmed line rejects the whole sale and consumes nothing', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const a = await paid(x, 1000); const b = await x.create({}, 1000);
    const body = (ids: string[]) => dto(x, { payments: ids.map((id) => qrLine(id, 10)) });
    expect(await code(svc.createSale(x.s.sellerId, body([a.id, b.id]) as any, undefined))).toBe('PAYMENT_NOT_CONFIRMED');
    expect(await code(svc.createSale(x.s.sellerId, body([a.id, a.id]) as any, undefined))).toBe('PAYMENT_USED_TWICE');
    expect(await x.eventTypes(a.id)).toEqual(['created', 'confirmed']);
    await x.send('confirmed', b.id);
    const res: any = await svc.createSale(x.s.sellerId, body([a.id, b.id]) as any, undefined);
    expect(res.data.payments).toHaveLength(2);
  });

  it('cancelling the checkout releases its unpaid QR lines and leaves a paid one for a manager', async () => {
    const x = await f.fresh();
    const unpaid = await x.create({ saleAttemptKey: 'chk-1' }, 1000);
    const paidOne = await x.create({ saleAttemptKey: 'chk-1' }, 1000); await x.send('confirmed', paidOne.id);
    const other = await x.create({ saleAttemptKey: 'chk-2' }, 1000);
    const r = await x.core.cancelAttempt(x.s.storeId, 'chk-1', x.s.cashierId);
    expect(r).toEqual({ cancelled: [unpaid.id], confirmed: [paidOne.id] });
    expect(await x.eventTypes(unpaid.id)).toEqual(['created', 'cancelled']);
    expect(await x.eventTypes(other.id)).toEqual(['created']);
    expect((await x.core.cancelAttempt(x.s.storeId, 'chk-1')).cancelled).toEqual([]); // idempotent
  });
});

describe('refunding a QR sale goes through provider refund events', () => {
  async function qrSale(x: X, svc: PosService) {
    const v = await paid(x);
    const res: any = await svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined);
    return { v, sale: res.data };
  }

  it('full refund: the provider refund succeeds as events, the sale is refunded, the drawer counter goes down, stock returns', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const { v, sale } = await qrSale(x, svc);
    const res: any = await svc.refundSale(x.s.sellerId, String(sale._id), { reason: 'wrong item' } as any, mgr(x));
    expect(res.data.digitalRefunds).toEqual([{ intentId: v.id, amountMinor: 2000, status: 'succeeded' }]);
    expect(res.data.tenders).toEqual([{ method: 'raast_qr', amount: 20 }]);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed', 'consumed', 'refund_requested', 'refund_succeeded']);
    expect((await x.core.getIntent(x.s.storeId, v.id))).toMatchObject({ refundedMinor: 2000, refundStatus: 'full' });
    expect(((await x.h.repos.registerSessionModel.findById(x.sessionId).lean()) as any).digitalSales).toBe(0);
    expect(await stockOf(x.h, x.s.variantId)).toBe(5);
  });

  it('partial refund (1 of 2 items) refunds half through the provider; a second partial refund the rest', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const { v, sale } = await qrSale(x, svc);
    const item = String(sale.items[0]._id);
    const r1: any = await svc.refundSale(x.s.sellerId, String(sale._id), { items: [{ saleItemId: item, qty: 1 }] } as any, mgr(x));
    expect(r1.data.digitalRefunds).toEqual([{ intentId: v.id, amountMinor: 1000, status: 'succeeded' }]);
    const r2: any = await svc.refundSale(x.s.sellerId, String(sale._id), { items: [{ saleItemId: item, qty: 1 }] } as any, mgr(x));
    expect(r2.data.digitalRefunds).toEqual([{ intentId: v.id, amountMinor: 1000, status: 'succeeded' }]);
    expect((await x.core.getIntent(x.s.storeId, v.id)).refundedMinor).toBe(2000);
  });

  it('refund retried with the same Idempotency-Key does not refund twice at the provider', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const { v, sale } = await qrSale(x, svc);
    const spy = jest.spyOn(x.mock, 'refund');
    await svc.refundSale(x.s.sellerId, String(sale._id), undefined, mgr(x), 'rk-1');
    await svc.refundSale(x.s.sellerId, String(sale._id), undefined, mgr(x), 'rk-1');
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await x.core.getIntent(x.s.storeId, v.id)).refundedMinor).toBe(2000);
    spy.mockRestore();
  });

  it('void of a QR sale refunds the whole payment through the provider', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const { v, sale } = await qrSale(x, svc);
    const res: any = await svc.voidSale(x.s.sellerId, String(sale._id), { reason: 'mistake' }, mgr(x));
    expect(res.data.digitalRefunds).toEqual([{ intentId: v.id, amountMinor: 2000, status: 'succeeded' }]);
    expect((await x.core.getIntent(x.s.storeId, v.id)).refundStatus).toBe('full');
  });

  it('a DECLINED provider refund: the sale-side refund stands, the failure is reported and listed in Needs attention; the manager retries it', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const { v, sale } = await qrSale(x, svc);
    const res: any = await svc.refundSale(x.s.sellerId, String(sale._id), { reason: 'mock:fail test' } as any, mgr(x));
    expect(res.data.newStatus).toBe('refunded');
    expect(res.data.digitalRefunds[0]).toMatchObject({ intentId: v.id, status: 'failed' });
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toEqual(['refund_failed']);
    const retry = await x.core.reconcile(x.s.storeId, v.id, x.manager, { resolution: 'refund', note: 'retry after the bank fixed it' });
    expect(retry).toMatchObject({ refundedMinor: 2000, attention: [] });
  });

  it('refunding a split sale sends only the QR share through the provider (non-cash first, in the order taken)', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x, 1200);
    const res: any = await svc.createSale(x.s.sellerId, dto(x, { paymentMethod: 'card', payments: [{ method: 'card', amount: 8 }, qrLine(v.id, 12)] }) as any, undefined);
    const r: any = await svc.refundSale(x.s.sellerId, String(res.data._id), { reason: 'return' } as any, mgr(x));
    expect(r.data.tenders).toEqual([{ method: 'card', amount: 8 }, { method: 'raast_qr', amount: 12 }]);
    expect(r.data.digitalRefunds).toEqual([{ intentId: v.id, amountMinor: 1200, status: 'succeeded' }]);
  });
});

describe('manager reconciliation of Needs attention items', () => {
  it('paid-but-no-sale: attach by receipt number; the item closes, audited; a second action is refused', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x);
    const sale: any = await svc.createSale(x.s.sellerId, dto(x, { paymentMethod: 'cash', payments: [{ method: 'cash', amount: 20 }] }) as any, undefined); // the till rang it up as cash by mistake
    process.env.PAYMENTS_UNATTACHED_GRACE_SECONDS = '0.001'; // "paid but never attached" after 1 ms, instead of the default 2 minutes
    await new Promise((r) => setTimeout(r, 20));
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toEqual(['confirmed_unattached']);
    const r = await x.core.reconcile(x.s.storeId, v.id, x.manager, { resolution: 'sale_recorded', saleNumber: sale.data.saleNumber, note: 'matched at the till' });
    delete process.env.PAYMENTS_UNATTACHED_GRACE_SECONDS;
    expect(r).toMatchObject({ saleId: String(sale.data._id), attention: [] });
    expect(await code(x.core.reconcile(x.s.storeId, v.id, x.manager, { resolution: 'refund' }))).toBe('ALREADY_RECONCILED');
    expect(await code(x.core.reconcile(x.s.storeId, v.id, x.manager, { resolution: 'sale_recorded', saleNumber: 'POS-99999' }))).toBe('ALREADY_RECONCILED');
    const audit: any = await x.h.repos.posAuditLogModel.findOne({ storeId: x.s.storeId, action: 'payment_reconciled' }).lean();
    expect(audit).toMatchObject({ employeeId: x.s.managerId, targetId: v.id, metadata: { resolution: 'sale_recorded', saleNumber: sale.data.saleNumber } });
  });

  it('attach to a sale that does not exist is refused; "resolved" needs a written note of 10+ characters and is audited', async () => {
    const x = await f.fresh();
    const a = await x.create({}, 2000); await x.core.cancel(x.s.storeId, a.id); await x.send('confirmed', a.id);
    expect(await code(x.core.reconcile(x.s.storeId, a.id, x.manager, { resolution: 'sale_recorded', saleNumber: 'POS-00042' }))).toBe('SALE_NOT_FOUND');
    expect(await code(x.core.reconcile(x.s.storeId, a.id, x.manager, { resolution: 'resolved', note: 'short' }))).toBe('NOTE_REQUIRED');
    expect(await code(x.core.reconcile(x.s.storeId, a.id, x.manager, { resolution: 'resolved' }))).toBe('NOTE_REQUIRED');
    const r = await x.core.reconcile(x.s.storeId, a.id, x.manager, { resolution: 'resolved', note: 'cash returned to the customer at the counter' });
    expect(r.attention).toEqual([]);
    const audit: any = await x.h.repos.posAuditLogModel.findOne({ storeId: x.s.storeId, action: 'payment_reconciled', targetId: a.id }).lean();
    expect(audit.metadata).toMatchObject({ resolution: 'resolved', note: 'cash returned to the customer at the counter' });
    expect(await x.eventTypes(a.id)).toEqual(['created', 'cancelled', 'confirmed(late)', 'reconciled']);
  });

  it('a resolved payment can no longer settle a sale', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const a = await x.create({}, 2000); await x.core.cancel(x.s.storeId, a.id); await x.send('confirmed', a.id);
    await x.core.reconcile(x.s.storeId, a.id, x.manager, { resolution: 'resolved', note: 'refunded in cash, see ticket 15' });
    expect(await code(svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(a.id)] }) as any, undefined))).toBe('PAYMENT_ALREADY_RESOLVED');
  });
});

describe('reports and the gate', () => {
  it('the shift report lists Raast sales as their own tender, apart from cash and card', async () => {
    const x = await f.fresh(); const svc = svcFor(x);
    const v = await paid(x);
    await svc.createSale(x.s.sellerId, dto(x, { payments: [qrLine(v.id)] }) as any, undefined);
    const rep: any = await svc.getSessionReport(x.s.sellerId, x.sessionId);
    const pm = (rep.data.summary ?? rep.data).byPaymentMethod ?? rep.data.byPaymentMethod;
    expect(pm.raast_qr).toMatchObject({ count: 1, total: 20, totalMinor: 2000 });
    expect(pm.cash.total).toBe(0);
  });

  it('a store that is not KYB-verified cannot even create the QR payment (cash and card are untouched)', async () => {
    const x = await f.fresh({ verified: false }); const svc = svcFor(x);
    expect(await code(x.create({}, 2000))).toBe('STORE_NOT_VERIFIED');
    const cash: any = await svc.createSale(x.s.sellerId, dto(x, { paymentMethod: 'cash', payments: [{ method: 'cash', amount: 20 }] }) as any, undefined);
    expect(cash.data.status).toBe('completed');
  });
});
