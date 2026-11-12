/* eslint-disable prettier/prettier */
import { Types } from 'mongoose';
import { makePaymentsFixture, secondInstance, setKybKeys } from './testing/payments-harness';

jest.setTimeout(120_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Two server instances (separate lease identities, separate service objects) against ONE database, running the jobs at the same time.
 * What must hold: no duplicate events, at most one instance working on a given payment at any moment, and everything still correct if a
 * lease expires mid-run (the writes are idempotent anyway).
 */
describe('two instances, one database: payments jobs', () => {
  let x: Awaited<ReturnType<typeof makePaymentsFixture>>; let b: ReturnType<typeof secondInstance>;
  beforeAll(async () => { x = await makePaymentsFixture({ supportsWebhooks: false }); b = secondInstance(x); });
  afterAll(async () => { await x.stop(); });

  const eventCounts = async () => {
    const rows: any[] = await x.events.aggregate([{ $group: { _id: { i: '$intentId', t: '$type' }, n: { $sum: 1 } } }]);
    return rows.filter((r) => ['created', 'expired', 'confirmed', 'failed', 'cancelled', 'presented', 'pending', 'reconciled', 'consumed'].includes(r._id.t) && r.n > 1);
  };

  it('QR expiry + polling: both pollers run together over 12 payments → every payment is handled once, never concurrently, no duplicate event', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push((await x.create()).id);
    // make them all due: expiry in the past; half of them were paid at the provider just before expiring
    await x.intents.collection.updateMany({ _id: { $in: ids.map((i) => new Types.ObjectId(i)) } }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    for (const id of ids.slice(0, 6)) x.mock.simulate(await x.providerRefOf(id), 'confirm');
    // instrument the provider: how many calls are in flight for the same charge at the same moment?
    const inflight = new Map<string, number>(); let maxPerCharge = 0; let calls = 0;
    const orig = x.mock.getStatus.bind(x.mock);
    const spy = jest.spyOn(x.mock, 'getStatus').mockImplementation(async (ref: string) => { calls++; const n = (inflight.get(ref) ?? 0) + 1; inflight.set(ref, n); maxPerCharge = Math.max(maxPerCharge, n); await sleep(40); try { return await orig(ref); } finally { inflight.set(ref, (inflight.get(ref) ?? 1) - 1); } });
    await Promise.all([x.poller.pollOnce(), b.poller.pollOnce()]);
    spy.mockRestore();
    expect(maxPerCharge).toBe(1);
    expect(await eventCounts()).toEqual([]);
    for (const id of ids.slice(0, 6)) expect(await x.eventTypes(id)).toEqual(['created', 'confirmed']);   // paid just in time: found by the last look
    for (const id of ids.slice(6)) expect(await x.eventTypes(id)).toEqual(['created', 'expired']);
    expect(calls).toBeGreaterThanOrEqual(12);
  });

  it('webhook retry queue: both instances retry the same failed notification at once → processed exactly once', async () => {
    const v = await x.create();
    const spy = jest.spyOn(x.core, 'applyOutcome').mockRejectedValueOnce(new Error('db blip'));
    await x.send('confirmed', v.id);
    spy.mockRestore();
    expect(await x.eventTypes(v.id)).toEqual(['created']);
    const later = new Date(Date.now() + 120_000);
    await Promise.all([x.webhooks.retryPending(later), b.webhooks.retryPending(later), x.webhooks.retryPending(later)]);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    const results = ((await x.outcomes.find().lean()) as any[]).filter((o) => o.result !== 'error');
    expect(results.filter((o) => o.result === 'processed')).toHaveLength(1);
  });

  it('the same inbox row processed by two instances at the same moment: one does it, the other skips', async () => {
    const v = await x.create();
    const w = x.mock.buildWebhook({ kind: 'confirmed', providerRef: await x.providerRefOf(v.id), amountMinor: 150000 });
    // durable write only (no inline processing), then both instances race to process it
    const crypto = await import('crypto');
    const row: any = (await x.inbox.create([{ providerKey: 'mock', providerEventId: 'race-row', rawDigest: crypto.createHash('sha256').update(w.body).digest('hex'), outcome: { providerEventId: 'race-row', providerRef: await x.providerRefOf(v.id), kind: 'confirmed', amountMinor: 150000, occurredAt: new Date().toISOString() } }]))[0];
    const [r1, r2] = await Promise.all([x.webhooks.processInboxRow(row), b.webhooks.processInboxRow(row)]);
    expect([r1, r2].sort()).toEqual(['processed', 'skipped']);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
    expect(await x.outcomes.countDocuments({ inboxId: String(row._id) })).toBe(1);
  });

  it('webhook (instance A) and poll (instance B) apply the same confirmation together → one `confirmed` event; the loser backs off or is a no-op', async () => {
    const v = await x.create();
    x.mock.simulate(await x.providerRefOf(v.id), 'confirm');
    const intent: any = await x.intents.findById(v.id).lean();
    const out = { providerEventId: null, providerRef: intent.providerRef, kind: 'confirmed' as const, amountMinor: 150000, occurredAt: new Date() };
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => (i % 2 ? b.core : x.core).applyOutcome(intent, i % 3 ? out : { ...out, providerEventId: `e${i}` }, i % 2 ? 'poll' : 'webhook')));
    expect(rs.filter((r) => r.wrote === 'confirmed')).toHaveLength(1);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
  });

  it('if a lease EXPIRES mid-run (a stalled instance wakes up late), the late writer changes nothing: unique event keys hold', async () => {
    const v = await x.create();
    const intent: any = await x.intents.findById(v.id).lean();
    const stale = (await x.leases.tryAcquire(`payments:apply:${v.id}`, 150))!;      // instance A takes the lease … and stalls
    expect(await b.leases.tryAcquire(`payments:apply:${v.id}`, 5000)).toBeNull();
    await sleep(300);                                                                  // … its lease expires; B takes over and finishes the job
    const out = { providerEventId: 'late-1', providerRef: intent.providerRef, kind: 'confirmed' as const, amountMinor: 150000, occurredAt: new Date() };
    expect((await b.core.applyOutcome(intent, out, 'webhook')).wrote).toBe('confirmed');
    expect(await x.leases.renew(stale)).toBe(false);                                  // A finds out it lost the lease …
    // … but even if A now writes its (stale) result directly, bypassing every lease, the database refuses the duplicate
    await expect(x.events.collection.insertOne({ intentId: v.id, storeId: x.s.storeId, seq: 99, type: 'confirmed', onceKey: `${v.id}:confirmed`, source: 'poll', at: new Date() })).rejects.toMatchObject({ code: 11000 });
    const dup = await x.core.appendEvent(intent, 'confirmed', { source: 'poll' });
    expect(dup.created).toBe(false);
    expect(await x.eventTypes(v.id)).toEqual(['created', 'confirmed']);
  });
});

describe('two instances, one database: KYB retention', () => {
  it('a real purge started on both at once deletes every document exactly once and audits once per store', async () => {
    setKybKeys({ v1: true, current: '1' });
    const x = await makePaymentsFixture({ verified: false }); const b = secondInstance(x);
    try {
      await x.maintenance.updateSettings('adm', { afterClosureDays: 30, purgeEnabled: true });
      const storeIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const sid = String(new Types.ObjectId()); storeIds.push(sid);
        await x.h.repos.storeModel.collection.insertOne({ _id: new Types.ObjectId(sid), sellerId: 's' + i, name: 'S' + i, slug: 'closed-' + sid, isDelete: true, updatedAt: new Date(Date.now() - 90 * 86400_000) });
        await x.kybModel.collection.insertOne({ storeId: sid, sellerId: 's' + i, status: 'verified', documents: [{ type: 'owner_cnic', publicId: `private/kyb/${sid}/a`, resourceType: 'raw', fileName: 'a.pdf' }, { type: 'bank_proof', publicId: `private/kyb/${sid}/b`, resourceType: 'raw', fileName: 'b.pdf' }], history: [], cnicEnc: 'kyb:v1:x:y:z', purgedAt: null });
      }
      x.upload.deletePrivateFile.mockImplementation(async () => { await sleep(30); return 'ok'; });
      const [r1, r2] = await Promise.all([x.maintenance.runRetention({ dryRun: false }), b.maintenance.runRetention({ dryRun: false })]);
      expect((r1.purged ?? 0) + (r2.purged ?? 0)).toBe(4);
      expect([r1, r2].filter((r) => r.skipped).length).toBe(1);                      // the other instance backed off
      const deleted = x.upload.deletePrivateFile.mock.calls.map((c: any[]) => c[0]);
      expect(new Set(deleted).size).toBe(deleted.length); expect(deleted).toHaveLength(8); // 4 stores × 2 documents, none twice
      expect(await x.kybAuditModel.countDocuments({ action: 'kyb_purged' })).toBe(4);
    } finally { await x.stop(); setKybKeys({ v1: false, current: null }); }
  });

  it('two key rotations at once: the second backs off, nothing is rotated twice', async () => {
    setKybKeys({ v1: true, current: '1' });
    const x = await makePaymentsFixture({ verified: false }); const b = secondInstance(x);
    try {
      const { sellerId, storeId } = x.s;
      await x.kyb.saveDraft(sellerId, storeId, { cnic: '3520212345671', iban: 'PK36SCBL0000001123456702' });
      process.env.KYB_ENC_KEY_V2 = Buffer.alloc(32, 2).toString('base64'); process.env.KYB_ENC_KEY_CURRENT = '2';
      const [r1, r2] = await Promise.all([x.maintenance.rotateKeys(), b.maintenance.rotateKeys()]);
      expect((r1.valuesRotated ?? 0) + (r2.valuesRotated ?? 0)).toBe(2);
    } finally { delete process.env.KYB_ENC_KEY_V2; await x.stop(); setKybKeys({ v1: false, current: null }); }
  });
});
