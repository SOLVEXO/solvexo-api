/* eslint-disable prettier/prettier */
import { startMongoHarness, MongoHarness } from '../../pos/testing/mongo-harness';
import { JobLease, JobLeaseSchema } from './job-lease.schema';
import { BUSY, JobLeaseService } from './job-lease.service';

jest.setTimeout(60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let h: MongoHarness; let A: JobLeaseService; let B: JobLeaseService;
beforeAll(async () => {
  h = await startMongoHarness();
  const model = h.conn.model(JobLease.name, JobLeaseSchema); await model.init();
  A = new JobLeaseService(model as any); B = new JobLeaseService(model as any);
});
afterAll(async () => { await h.stop(); });

describe('JobLeaseService (MongoDB lease, database clock)', () => {
  it('only one of many concurrent acquirers gets a lease; the rest are told it is busy', async () => {
    const services = Array.from({ length: 12 }, () => new JobLeaseService(A.model));
    const got = await Promise.all(services.map((s) => s.tryAcquire('race', 5000)));
    expect(got.filter(Boolean)).toHaveLength(1);
  });

  it('release frees it at once; each acquisition bumps the fencing epoch', async () => {
    const l1 = (await A.tryAcquire('rel', 5000))!; expect(l1.epoch).toBe(1);
    expect(await B.tryAcquire('rel', 5000)).toBeNull();
    await A.release(l1);
    const l2 = (await B.tryAcquire('rel', 5000))!; expect(l2.epoch).toBe(2);
  });

  it('an EXPIRED lease is taken over; the stale holder can no longer renew or release it', async () => {
    const a = (await A.tryAcquire('exp', 300))!;
    expect(await B.tryAcquire('exp', 300)).toBeNull();
    await sleep(500);
    const b = (await B.tryAcquire('exp', 5000))!;
    expect(b.epoch).toBe(a.epoch + 1);
    expect(await A.renew(a)).toBe(false);        // the old holder lost it
    await A.release(a);                           // a no-op: must not free B's lease
    expect(await A.tryAcquire('exp', 5000)).toBeNull();
    expect(await B.renew(b)).toBe(true);
  });

  it('renew extends a live lease past its original expiry', async () => {
    const a = (await A.tryAcquire('renew', 400))!;
    await sleep(250); expect(await A.renew(a, 400)).toBe(true);
    await sleep(250); expect(await B.tryAcquire('renew', 400)).toBeNull(); // 500 ms after start but renewed at 250
    await sleep(500); expect(await B.tryAcquire('renew', 400)).not.toBeNull();
  });

  it('withLease heartbeats a long job (it keeps the lease past its TTL), releases afterwards, and releases on error', async () => {
    const out = await A.withLease('long', 450, async (ctx) => { await sleep(1300); expect(await B.tryAcquire('long', 450)).toBeNull(); return ctx.isValid(); });
    expect(out).toBe(true);
    expect(await B.tryAcquire('long', 450)).not.toBeNull(); // released after the run
    await expect(A.withLease('err', 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await B.tryAcquire('err', 5000)).not.toBeNull();
  });

  it('withLease returns BUSY without running the job when someone else holds the lease', async () => {
    const held = (await A.tryAcquire('busy', 5000))!;
    let ran = false;
    expect(await B.withLease('busy', 5000, async () => { ran = true; })).toBe(BUSY);
    expect(ran).toBe(false);
    await A.release(held);
  });

  it('uses the DATABASE clock: it does not matter what time a server thinks it is', async () => {
    const real = Date.now; Date.now = () => real() + 3 * 3600 * 1000; // server B's clock is 3 hours fast
    try { const a = (await A.tryAcquire('skew', 5000))!; expect(await B.tryAcquire('skew', 5000)).toBeNull(); await A.release(a); } finally { Date.now = real; }
  });

  it('a lease that outlives its holder (crash) frees itself after the TTL', async () => {
    await A.tryAcquire('crash', 300); // never released
    expect(await B.tryAcquire('crash', 300)).toBeNull();
    await sleep(500);
    expect(await B.tryAcquire('crash', 300)).not.toBeNull();
  });
});
