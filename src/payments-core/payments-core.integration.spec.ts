/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { makePaymentsFixture } from './testing/payments-harness';

jest.setTimeout(120_000);

type F = Awaited<ReturnType<typeof makePaymentsFixture>>;
// every test gets its OWN fixture (own database, own store/session/KYB) so tests cannot see each other's data
async function fresh(opts: Parameters<typeof makePaymentsFixture>[0] = {}) { const x = await makePaymentsFixture(opts); return x; }

describe('create: gate, amount, idempotency, expiry cap', () => {
  it('a store that is not KYB-verified cannot create a QR payment (403 STORE_NOT_VERIFIED) and nothing is created', async () => {
    const x = await fresh({ verified: false });
    await expect(x.create()).rejects.toMatchObject({ response: { code: 'STORE_NOT_VERIFIED' } });
    expect(await x.intents.countDocuments()).toBe(0);
    await x.stop();
  });

  it('verified but no sub-merchant, a sub-merchant of ANOTHER provider, and a revoked KYB are all refused; a verified store works', async () => {
    const x = await fresh({ verified: false });
    const { storeId, sellerId } = x.s;
    await x.kybModel.collection.insertOne({ storeId, sellerId, status: 'verified', subMerchant: { ref: null, providerKey: null } });
    await expect(x.create()).rejects.toMatchObject({ response: { code: 'STORE_NOT_VERIFIED', reason: 'no_sub_merchant' } });
    await x.kybModel.collection.updateOne({ storeId }, { $set: { subMerchant: { ref: 'SM-9', providerKey: 'payfast' } } });
    await expect(x.create()).rejects.toMatchObject({ response: { reason: 'sub_merchant_other_provider' } });
    await x.kybModel.collection.updateOne({ storeId }, { $set: { subMerchant: { ref: 'SM-9', providerKey: 'mock' } } });
    const v = await x.create();
    expect(v).toMatchObject({ status: 'created', amountMinor: 150000, currency: 'PKR', currencyExponent: 2 });
    await x.kybModel.collection.updateOne({ storeId }, { $set: { status: 'rejected' } }); // revoked: stops IMMEDIATELY
    await expect(x.create()).rejects.toMatchObject({ response: { reason: 'kyb_rejected' } });
    await x.stop();
  });

  it('amounts must be positive safe integers in minor units; the same idempotency key returns the same payment; a different amount under the same key is refused', async () => {
    const x = await fresh();
    for (const bad of [0, -5, 1.5, NaN, 2 ** 60, '100' as any]) await expect(x.create({}, bad)).rejects.toMatchObject({ response: { code: expect.stringMatching(/INVALID_AMOUNT|AMOUNT_TOO_LARGE/) } });
    const a = await x.create({ idempotencyKey: 'same' });
    const b = await x.create({ idempotencyKey: 'same' });
    expect(b.id).toBe(a.id);
    expect(await x.intents.countDocuments()).toBe(1);
    await expect(x.create({ idempotencyKey: 'same' }, 999)).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    // two taps racing: still ONE payment
    const [c, d] = await Promise.all([x.create({ idempotencyKey: 'race' }), x.create({ idempotencyKey: 'race' })]);
    expect(c.id).toBe(d.id);
    expect(await x.intents.countDocuments({ idempotencyKey: 'race' })).toBe(1);
    await x.stop();
  });

  it('the QR expiry defaults to 3 minutes and is NEVER longer than the provider\'s own QR validity; the countdown comes from the server clock', async () => {
    const x = await fresh();
    const v = await x.create();
    const secs = (new Date(v.expiresAt).getTime() - Date.now()) / 1000;
    expect(secs).toBeGreaterThan(170); expect(secs).toBeLessThanOrEqual(180);
    expect(v.secondsRemaining).toBeGreaterThan(170);
    expect(new Date(v.serverTime).getTime()).toBeLessThanOrEqual(Date.now());
    const short = await fresh({ qrValiditySeconds: 60 });
    const w = await short.create();
    expect((new Date(w.expiresAt).getTime() - Date.now()) / 1000).toBeLessThanOrEqual(60);
    await x.stop(); await short.stop();
  });

  it('per-provider TTL override via env', async () => {
    const x = await fresh();
    process.env.PAYMENTS_QR_TTL_SECONDS_MOCK = '90';
    try { const v = await x.create(); expect((new Date(v.expiresAt).getTime() - Date.now()) / 1000).toBeLessThanOrEqual(90); } finally { delete process.env.PAYMENTS_QR_TTL_SECONDS_MOCK; }
    await x.stop();
  });

  it('needs an open register session of this store', async () => {
    const x = await fresh();
    await expect(x.core.createIntent(x.actor, { amountMinor: 100, sessionId: String(new Types.ObjectId()), idempotencyKey: 'z' })).rejects.toMatchObject({ response: { code: 'NO_OPEN_SESSION' } });
    await x.stop();
  });
});

describe('webhook: signature, replay, duplicates, idempotent processing', () => {
  it('confirm: a valid signed webhook confirms the payment; status derives from the events', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.core.markPresented(x.s.storeId, v.id);
    const r = await x.send('confirmed', v.id);
    expect(r).toEqual({ received: true, duplicate: false });
    expect(await x.eventTypes(v.id)).toEqual(['created', 'presented', 'confirmed']);
    expect(await x.core.getIntent(x.s.storeId, v.id)).toMatchObject({ status: 'confirmed', paidAfterExpiry: false, secondsRemaining: 0 });
    await x.stop();
  });

  it('a DUPLICATE webhook (same provider event id) answers 2xx and writes nothing new', async () => {
    const x = await fresh();
    const v = await x.create();
    const providerRef = await x.providerRefOf(v.id);
    const w = x.mock.buildWebhook({ kind: 'confirmed', providerRef, amountMinor: 150000, eventId: 'evt_dup' });
    const a = await x.webhooks.receive('mock', w.body, w.headers);
    const b = await x.webhooks.receive('mock', w.body, w.headers);
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    expect(await x.inbox.countDocuments()).toBe(1);
    await x.stop();
  });

  it('two DIFFERENT notifications confirming the same payment (webhook + poll, two servers) write exactly one `confirmed` event', async () => {
    const x = await fresh();
    const v = await x.create();
    const intent: any = await x.intents.findById(v.id).lean();
    const out = (id: string | null) => ({ providerEventId: id, providerRef: intent.providerRef, kind: 'confirmed' as const, amountMinor: 150000, occurredAt: new Date() });
    await Promise.all([x.core.applyOutcome(intent, out('e1'), 'webhook'), x.core.applyOutcome(intent, out('e2'), 'webhook'), x.core.applyOutcome(intent, out(null), 'poll')]);
    expect((await x.eventTypes(v.id)).filter((t) => t === 'confirmed')).toHaveLength(1);
    await x.stop();
  });

  it('an INVALID signature, a TAMPERED body and a MALFORMED header are all 401 and leave no trace (no inbox row, no event)', async () => {
    const x = await fresh();
    const v = await x.create();
    const ref = await x.providerRefOf(v.id);
    const bad = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 150000, badSignature: true });
    await expect(x.webhooks.receive('mock', bad.body, bad.headers)).rejects.toMatchObject({ response: { code: 'WEBHOOK_BAD_SIGNATURE' } });
    const tampered = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 1, tamperBodyAfterSigning: true });
    await expect(x.webhooks.receive('mock', tampered.body, tampered.headers)).rejects.toMatchObject({ response: { code: 'WEBHOOK_BAD_SIGNATURE' } });
    await expect(x.webhooks.receive('mock', Buffer.from('{}'), {})).rejects.toMatchObject({ response: { code: 'WEBHOOK_BAD_SIGNATURE' } });
    await expect(x.webhooks.receive('mock', Buffer.from('{}'), { 'x-mock-signature': 't=abc,v1=zz' })).rejects.toMatchObject({ response: { code: 'WEBHOOK_BAD_SIGNATURE' } });
    await expect(x.webhooks.receive('nope', Buffer.from('{}'), {})).rejects.toMatchObject({ status: 404 });
    expect(await x.inbox.countDocuments()).toBe(0);
    expect(await x.eventTypes(v.id)).toEqual(['created']);
    await x.stop();
  });

  it('REPLAY protection: a correctly signed but stale (or far-future) notification is rejected', async () => {
    const x = await fresh();
    const v = await x.create();
    const ref = await x.providerRefOf(v.id);
    const old = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 150000, at: new Date(Date.now() - 10 * 60 * 1000) });
    await expect(x.webhooks.receive('mock', old.body, old.headers)).rejects.toMatchObject({ response: { code: 'WEBHOOK_REPLAY' } });
    const future = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 150000, at: new Date(Date.now() + 10 * 60 * 1000) });
    await expect(x.webhooks.receive('mock', future.body, future.headers)).rejects.toMatchObject({ response: { code: 'WEBHOOK_REPLAY' } });
    expect(await x.eventTypes(v.id)).toEqual(['created']);
    // within the window it is accepted
    const ok = x.mock.buildWebhook({ kind: 'confirmed', providerRef: ref, amountMinor: 150000, at: new Date(Date.now() - 60 * 1000) });
    await expect(x.webhooks.receive('mock', ok.body, ok.headers)).resolves.toMatchObject({ received: true });
    await x.stop();
  });

  it('a webhook with the WRONG AMOUNT never confirms: it becomes an anomaly a manager must resolve', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.send('confirmed', v.id, { amountMinor: 100000 });
    expect(await x.eventTypes(v.id)).toEqual(['created', 'anomaly']);
    const view = await x.core.getIntent(x.s.storeId, v.id);
    expect(view).toMatchObject({ status: 'created', attention: ['anomaly'] });
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toEqual(['anomaly']);
    await x.stop();
  });

  it('failed/expired AFTER confirmed is an anomaly — a paid payment never goes back to unpaid', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.send('confirmed', v.id);
    await x.send('failed', v.id);
    await x.send('expired', v.id);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed', 'anomaly', 'anomaly']);
    expect((await x.core.getIntent(x.s.storeId, v.id)).status).toBe('confirmed');
    await x.stop();
  });

  it('a failed payment is terminal; a later duplicate failure writes nothing', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.send('failed', v.id);
    await x.send('failed', v.id);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'failed']);
    await x.stop();
  });
});

describe('processing errors go to a retry queue (the provider always gets a 2xx once the notification is durable)', () => {
  it('an error while processing is recorded, answered 2xx, and retried with backoff until it succeeds', async () => {
    const x = await fresh();
    const v = await x.create();
    const spy = jest.spyOn(x.core, 'applyOutcome').mockRejectedValueOnce(new Error('db blip'));
    const r = await x.send('confirmed', v.id);
    expect(r.received).toBe(true);
    expect(await x.eventTypes(v.id)).toEqual(['created']);
    expect(await x.outcomes.find().lean()).toMatchObject([{ result: 'error', attempt: 1, error: 'db blip' }]);
    // too early: backoff not elapsed
    expect(await x.webhooks.retryPending(new Date())).toBe(0);
    // later: retried and processed
    expect(await x.webhooks.retryPending(new Date(Date.now() + 60_000))).toBe(1);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    expect((await x.outcomes.find().sort({ at: 1 }).lean() as any[]).map((o) => o.result)).toEqual(['error', 'processed']);
    // nothing left to retry
    expect(await x.webhooks.retryPending(new Date(Date.now() + 3600_000))).toBe(0);
    spy.mockRestore();
    await x.stop();
  });

  it('a notification for an unknown charge is kept, retried, and finally marked dead — never dropped silently', async () => {
    const x = await fresh();
    const w = x.mock.buildWebhook({ kind: 'confirmed', providerRef: 'mock_unknown', amountMinor: 5 });
    await x.webhooks.receive('mock', w.body, w.headers);
    let t = Date.now();
    for (let i = 0; i < 12; i++) { t += 11 * 60 * 1000; await x.webhooks.retryPending(new Date(t)); }
    const results = (await x.outcomes.find().sort({ at: 1 }).lean() as any[]).map((o) => o.result);
    expect(results.filter((r) => r === 'error')).toHaveLength(7);
    expect(results[results.length - 1]).toBe('dead');
    expect(await x.inbox.countDocuments()).toBe(1);
    await x.stop();
  });
});

describe('expiry, cancel and LATE payments (money is never lost)', () => {
  it('an unpaid QR expires after its time; the poller does one last provider look first', async () => {
    const x = await fresh();
    const v = await x.create();
    const later = new Date(Date.now() + 200_000);
    await x.poller.pollOnce(later);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'expired']);
    expect((await x.core.getIntent(x.s.storeId, v.id)).status).toBe('expired');
    await x.stop();
  });

  it('a payment made JUST in time is found by the last look instead of being expired', async () => {
    const x = await fresh();
    const v = await x.create();
    x.mock.simulate(await x.providerRefOf(v.id), 'confirm'); // customer paid; the webhook has not arrived
    await x.poller.pollOnce(new Date(Date.now() + 200_000));
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    await x.stop();
  });

  it('LATE CONFIRM after expiry: recorded as confirmed (late), attached to the original sale attempt, and raised for a manager', async () => {
    const x = await fresh();
    const v = await x.create({ saleAttemptKey: 'checkout-77' });
    await x.core.expireIfDue(await x.intents.findById(v.id).lean(), new Date(Date.now() + 200_000));
    await x.send('confirmed', v.id);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'expired', 'confirmed(late)']);
    const view = await x.core.getIntent(x.s.storeId, v.id);
    expect(view).toMatchObject({ status: 'confirmed', paidAfterExpiry: true, saleAttemptKey: 'checkout-77', attention: ['paid_after_expiry'] });
    const list = await x.core.listAttention(x.s.storeId);
    expect(list.items).toMatchObject([{ intentId: v.id, reason: 'paid_after_expiry', amountMinor: 150000, saleAttemptKey: 'checkout-77', currency: 'PKR' }]);
    await x.stop();
  });

  it('LATE CONFIRM after the cashier CANCELLED is handled the same way', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.core.cancel(x.s.storeId, v.id, x.s.cashierId);
    await x.send('confirmed', v.id);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'cancelled', 'confirmed(late)']);
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toEqual(['paid_after_expiry']);
    await x.stop();
  });

  it('a late payment is found by POLLING too, for a provider without webhooks (late-window watch)', async () => {
    const x = await fresh({ supportsWebhooks: false });
    const v = await x.create();
    await x.poller.pollOnce(new Date(Date.now() + 200_000)); // expires
    x.mock.simulate(await x.providerRefOf(v.id), 'confirm');
    await x.poller.pollOnce(new Date(Date.now() + 300_000));
    expect(await x.eventTypes(v.id)).toEqual(['created', 'expired', 'confirmed(late)']);
    await x.stop();
  });

  it('a manager resolves the late payment: attach to a sale (must exist) or refund it; each closes the item exactly once', async () => {
    const x = await fresh();
    const v1 = await x.create();
    await x.core.expireIfDue(await x.intents.findById(v1.id).lean(), new Date(Date.now() + 200_000));
    await x.send('confirmed', v1.id);
    await expect(x.core.reconcile(x.s.storeId, v1.id, x.manager, { resolution: 'sale_recorded', saleId: String(new Types.ObjectId()) })).rejects.toMatchObject({ response: { code: 'SALE_NOT_FOUND' } });
    const saleId = new Types.ObjectId();
    await x.h.repos.saleModel.collection.insertOne({ _id: saleId, storeId: x.s.storeId, saleNumber: 'POS-1', status: 'completed' });
    await x.core.reconcile(x.s.storeId, v1.id, x.manager, { resolution: 'sale_recorded', saleId: String(saleId), note: 'customer re-rang it' });
    expect((await x.core.listAttention(x.s.storeId)).items).toEqual([]);
    await expect(x.core.reconcile(x.s.storeId, v1.id, x.manager, { resolution: 'refund' })).rejects.toMatchObject({ response: { code: 'ALREADY_RECONCILED' } });

    const v2 = await x.create();
    await x.core.cancel(x.s.storeId, v2.id, x.s.cashierId);
    x.mock.simulate(await x.providerRefOf(v2.id), 'confirm');
    await x.send('confirmed', v2.id);
    const r = await x.core.reconcile(x.s.storeId, v2.id, x.manager, { resolution: 'refund', note: 'sent back' });
    expect(r).toMatchObject({ refundedMinor: 150000, refundStatus: 'full', attention: [] });
    expect(await x.eventTypes(v2.id)).toEqual(['created', 'cancelled', 'confirmed(late)', 'refund_requested', 'refund_succeeded', 'reconciled']);
    const audits = await x.h.repos.posAuditLogModel.find({ action: { $in: ['payment_reconciled', 'payment_refund_requested'] } }).lean();
    expect(audits.length).toBeGreaterThanOrEqual(3);
    await x.stop();
  });

  it('a payment that is confirmed but never attached to a sale shows up after the grace period (app crashed after "paid")', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.send('confirmed', v.id);
    expect((await x.core.listAttention(x.s.storeId)).items).toEqual([]);
    const later = new Date(Date.now() + 5 * 60 * 1000);
    expect((await x.core.listAttention(x.s.storeId, later)).items.map((i) => i.reason)).toEqual(['confirmed_unattached']);
    await x.stop();
  });

  it('cancel after confirmation is refused (refund instead); cancel is idempotent', async () => {
    const x = await fresh();
    const a = await x.create(); const b = await x.create();
    await x.send('confirmed', a.id);
    await expect(x.core.cancel(x.s.storeId, a.id)).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_CONFIRMED' } });
    await x.core.cancel(x.s.storeId, b.id); await x.core.cancel(x.s.storeId, b.id);
    expect(await x.eventTypes(b.id)).toEqual(['created', 'cancelled']);
    await x.stop();
  });
});

describe('polling for providers without webhooks', () => {
  it('confirms via poll; spaces calls with a backoff; a failed charge is recorded', async () => {
    const x = await fresh({ supportsWebhooks: false });
    const ok = await x.create({ mockScenario: 'auto_confirm' });
    const bad = await x.create({ mockScenario: 'auto_fail' });
    const pending = await x.create();
    const t0 = new Date();
    expect(await x.poller.pollOnce(t0)).toBe(3);
    expect(await x.eventTypes(ok.id)).toEqual(['created', 'confirmed']);
    expect(await x.eventTypes(bad.id)).toEqual(['created', 'failed']);
    expect(await x.eventTypes(pending.id)).toEqual(['created', 'pending']); // the provider says "still pending": recorded once, not on every poll
    // immediately again: the still-open charge is NOT hammered
    expect(await x.poller.pollOnce(new Date(t0.getTime() + 500))).toBe(0);
    // a few seconds later it is polled again
    expect(await x.poller.pollOnce(new Date(t0.getTime() + 4000))).toBe(1);
    await x.stop();
  });

  it('webhook providers get only a slow safety-net poll', async () => {
    const x = await fresh({ supportsWebhooks: true });
    await x.create();
    const t0 = new Date();
    expect(await x.poller.pollOnce(t0)).toBe(1);
    expect(await x.poller.pollOnce(new Date(t0.getTime() + 5000))).toBe(0);
    expect(await x.poller.pollOnce(new Date(t0.getTime() + 31_000))).toBe(1);
    await x.stop();
  });
});

describe('provider refunds are their own events', () => {
  const confirmed = async (x: F, amount = 150000) => { const v = await x.create({}, amount); await x.send('confirmed', v.id); return v; };

  it('partial then remaining refund; idempotent retry; cannot exceed what was paid; needs a reason', async () => {
    const x = await fresh();
    const v = await confirmed(x);
    const r1 = await x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 50000, reason: 'wrong item', refundKey: 'r1' });
    expect(r1).toMatchObject({ status: 'succeeded', refundedMinor: 50000, payment: { refundStatus: 'partial' } });
    const again = await x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 50000, reason: 'wrong item', refundKey: 'r1' });
    expect(again.refundedMinor).toBe(50000);
    expect((await x.eventTypes(v.id)).filter((t) => t.startsWith('refund_'))).toEqual(['refund_requested', 'refund_succeeded']);
    await expect(x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 50000, reason: 'x', refundKey: 'r1x' }).then(() => x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 60000, reason: 'too much', refundKey: 'r2' }))).rejects.toMatchObject({ response: { code: 'REFUND_EXCEEDS_PAID' } });
    await expect(x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 100, reason: '  ', refundKey: 'r3' })).rejects.toMatchObject({ response: { code: 'REASON_REQUIRED' } });
    await expect(x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 50000, reason: 'ok', refundKey: 'r1' }).then(async () => x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 49999, reason: 'ok', refundKey: 'r1' }))).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    await x.stop();
  });

  it('two refunds racing for more than the paid amount: exactly one is accepted, the provider is called once', async () => {
    const x = await fresh();
    const v = await confirmed(x, 100000);
    const spy = jest.spyOn(x.mock, 'refund');
    const results = await Promise.allSettled([
      x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 70000, reason: 'a', refundKey: 'ra' }),
      x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 70000, reason: 'b', refundKey: 'rb' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await x.core.getIntent(x.s.storeId, v.id)).refundedMinor).toBe(70000);
    spy.mockRestore();
    await x.stop();
  });

  it('an unconfirmed payment cannot be refunded', async () => {
    const x = await fresh();
    const v = await x.create();
    await expect(x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 100, reason: 'r', refundKey: 'k' })).rejects.toMatchObject({ response: { code: 'PAYMENT_NOT_CONFIRMED' } });
    await x.stop();
  });

  it('a PENDING provider refund finishes by poll or by webhook; a DECLINED one is recorded and needs attention', async () => {
    const x = await fresh();
    const v = await confirmed(x);
    const ref = await x.providerRefOf(v.id);
    const p = await x.core.refund(x.s.storeId, v.id, x.manager, { amountMinor: 30000, reason: 'mock:pending please', refundKey: 'rp' });
    expect(p).toMatchObject({ status: 'pending', refundedMinor: 0, payment: { refundStatus: 'pending' } });
    expect(await x.poller.pollOnce(new Date())).toBeGreaterThanOrEqual(1);
    expect((await x.core.getIntent(x.s.storeId, v.id)).refundedMinor).toBe(0); // still pending at the provider
    x.mock.finishRefund(ref, 'rp', true);
    await x.poller.pollOnce(new Date(Date.now() + 60_000));
    expect((await x.core.getIntent(x.s.storeId, v.id)).refundedMinor).toBe(30000);

    const q = await confirmed(x);
    const qref = await x.providerRefOf(q.id);
    await x.core.refund(x.s.storeId, q.id, x.manager, { amountMinor: 20000, reason: 'mock:pending', refundKey: 'rw' });
    const w = x.mock.buildWebhook({ kind: 'refund_succeeded', providerRef: qref, amountMinor: 20000, refundId: 'rw' });
    await x.webhooks.receive('mock', w.body, w.headers);
    expect((await x.core.getIntent(x.s.storeId, q.id)).refundedMinor).toBe(20000);

    const d = await confirmed(x);
    const res = await x.core.refund(x.s.storeId, d.id, x.manager, { amountMinor: 10000, reason: 'mock:fail', refundKey: 'rf' });
    expect(res).toMatchObject({ status: 'failed', refundedMinor: 0 });
    expect((await x.core.listAttention(x.s.storeId)).items.map((i) => i.reason)).toContain('refund_failed');
    await x.stop();
  });
});

describe('append-only: no row of any payment collection can be updated or deleted through the app', () => {
  it('intents, events, inbox, outcomes and the payment record itself reject updates and deletes', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.send('confirmed', v.id);
    for (const model of [x.intents, x.events, x.inbox, x.outcomes]) {
      await expect((model as any).updateOne({}, { $set: { storeId: 'x' } })).rejects.toThrow(/append-only/);
      await expect((model as any).deleteMany({})).rejects.toThrow(/append-only/);
    }
    const doc: any = await x.events.findOne({}); doc.note = 'tamper';
    await expect(doc.save()).rejects.toThrow(/append-only/);
    // the G1a hook is gone: even the payment record's old "confirmation fields" cannot be set
    await expect(x.h.repos.posPaymentModel.updateOne({}, { $set: { status: 'confirmed' } })).rejects.toThrow(/append-only/);
    await x.stop();
  });

  it('the database enforces one sequence number per intent and one event per provider notification id', async () => {
    const x = await fresh();
    const v = await x.create();
    const base = { intentId: v.id, storeId: x.s.storeId, source: 'system', at: new Date() };
    await expect(x.events.collection.insertOne({ ...base, seq: 1, type: 'pending' })).rejects.toMatchObject({ code: 11000 });
    await x.events.collection.insertOne({ ...base, seq: 2, type: 'anomaly', providerKey: 'mock', providerEventId: 'p1' });
    await expect(x.events.collection.insertOne({ ...base, seq: 3, type: 'anomaly', providerKey: 'mock', providerEventId: 'p1' })).rejects.toMatchObject({ code: 11000 });
    await x.events.collection.insertOne({ ...base, seq: 3, type: 'confirmed', onceKey: `${v.id}:confirmed` });
    await expect(x.events.collection.insertOne({ ...base, seq: 4, type: 'confirmed', onceKey: `${v.id}:confirmed` })).rejects.toMatchObject({ code: 11000 });
    await x.stop();
  });
});

describe('money is minor-only with a currency/exponent snapshot', () => {
  it('intents and events store BSON longs and the snapshot; the API returns plain integers', async () => {
    const x = await fresh();
    const v = await x.create();
    await x.send('confirmed', v.id);
    // the driver promotes safe longs to numbers on read, so ask the database for the stored BSON type
    expect(await x.intents.collection.countDocuments({ _id: new Types.ObjectId(v.id), amountMinor: { $type: 'long' }, currency: 'PKR', currencyExponent: 2 })).toBe(1);
    expect(await x.events.collection.countDocuments({ intentId: v.id, type: 'confirmed', amountMinor: { $type: 'long' } })).toBe(1);
    expect(typeof v.amountMinor).toBe('number');
    expect(Number.isInteger(v.amountMinor)).toBe(true);
    await x.stop();
  });
});
