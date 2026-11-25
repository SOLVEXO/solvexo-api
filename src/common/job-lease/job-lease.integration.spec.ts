/* eslint-disable prettier/prettier */
import { startMongoHarness, MongoHarness } from '../../pos/testing/mongo-harness';
import { JobLease, JobLeaseSchema } from './job-lease.schema';
import { BUSY, JobLeaseService } from './job-lease.service';

// Deterministic (G6.4): every expiry test moves a controllable clock forward instead of sleeping against the database clock, and the
// heartbeat is run explicitly — so a slow CI runner cannot change any outcome. The last-but-one test still uses the REAL database clock
// ($$NOW) to prove server clock skew does not matter.
jest.setTimeout(60_000);
let h: MongoHarness; let A: JobLeaseService; let B: JobLeaseService;

/** The test clock both services read: starts at a fixed instant and only moves when a test says so. */
const clock = { t: Date.UTC(2026, 10, 16, 9, 0, 0), now: () => new Date(clock.t), advance: (ms: number) => { clock.t += ms; } };

/** Runs A's heartbeats on demand: withLease registers its beat here instead of on a real interval. */
let beat: (() => Promise<void>) | null = null;

// Setup (connecting to the shared mongod, building the index) gets a generous allowance of its own: on a loaded machine it can take more
// than the 60 s per-test limit, and a slow START is not a lease result. The tests themselves keep the normal timeout.
beforeAll(async () => {
  h = await startMongoHarness();
  const model = h.conn.model(JobLease.name, JobLeaseSchema); await model.init();
  A = new JobLeaseService(model as any); B = new JobLeaseService(model as any);
}, 180_000);
beforeEach(() => {
  clock.advance(60 * 60 * 1000); // a fresh hour per test: nothing left over from the previous one can still be live
  for (const s of [A, B]) s.clock = clock.now;
  A.schedule = (b) => { beat = b; return () => { beat = null; }; };
});
afterAll(async () => { await h?.stop(); });

describe('JobLeaseService (MongoDB lease, database clock)', () => {
  it('only one of many concurrent acquirers gets a lease; the rest are told it is busy', async () => {
    const services = Array.from({ length: 12 }, () => { const s = new JobLeaseService(A.model); s.clock = clock.now; return s; });
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
    clock.advance(299); expect(await B.tryAcquire('exp', 300)).toBeNull(); // 1 ms before expiry: still held
    clock.advance(1);                                                        // exactly at expiry: free
    const b = (await B.tryAcquire('exp', 5000))!;
    expect(b.epoch).toBe(a.epoch + 1);
    expect(await A.renew(a)).toBe(false);        // the old holder lost it
    await A.release(a);                           // a no-op: must not free B's lease
    expect(await A.tryAcquire('exp', 5000)).toBeNull();
    expect(await B.renew(b)).toBe(true);
  });

  it('renew extends a live lease past its original expiry', async () => {
    const a = (await A.tryAcquire('renew', 400))!;
    clock.advance(250); expect(await A.renew(a, 400)).toBe(true);           // renewed at 250 → now expires at 650
    clock.advance(250); expect(await B.tryAcquire('renew', 400)).toBeNull(); // 500: past the ORIGINAL expiry (400), still held
    clock.advance(149); expect(await B.tryAcquire('renew', 400)).toBeNull(); // 649: still held
    clock.advance(1); expect(await B.tryAcquire('renew', 400)).not.toBeNull(); // 650: the renewed lease ran out
  });

  it('a lease cannot be renewed once it has expired (renew never resurrects it)', async () => {
    const a = (await A.tryAcquire('late', 400))!;
    clock.advance(400);
    expect(await A.renew(a, 400)).toBe(false);
    expect(await B.tryAcquire('late', 400)).not.toBeNull();
  });

  it('withLease heartbeats a long job (it keeps the lease past its TTL), releases afterwards, and releases on error', async () => {
    const out = await A.withLease('long', 450, async (ctx) => {
      expect(beat).not.toBeNull(); // the heartbeat was scheduled
      for (let i = 0; i < 4; i++) { clock.advance(300); await beat!(); } // 1 200 ms of work, a beat every 300 ms (< TTL 450)
      expect(await B.tryAcquire('long', 450)).toBeNull();
      return ctx.isValid();
    });
    expect(out).toBe(true);
    expect(beat).toBeNull(); // the heartbeat stopped
    expect(await B.tryAcquire('long', 450)).not.toBeNull(); // released after the run
    await expect(A.withLease('err', 5000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(beat).toBeNull();
    expect(await B.tryAcquire('err', 5000)).not.toBeNull();
  });

  it('withLease: a heartbeat that finds the lease gone (expired and taken) turns isValid() false', async () => {
    const out = await A.withLease('lost', 450, async (ctx) => {
      clock.advance(450);                                       // stalled past the TTL with no beat …
      expect(await B.tryAcquire('lost', 450)).not.toBeNull();   // … someone else takes over
      await beat!();
      return ctx.isValid();
    });
    expect(out).toBe(false);
  });

  it('withLease returns BUSY without running the job when someone else holds the lease', async () => {
    const held = (await A.tryAcquire('busy', 5000))!;
    let ran = false;
    expect(await B.withLease('busy', 5000, async () => { ran = true; })).toBe(BUSY);
    expect(ran).toBe(false);
    await A.release(held);
  });

  it('uses the DATABASE clock: it does not matter what time a server thinks it is', async () => {
    for (const s of [A, B]) s.clock = null; // the real $$NOW
    const real = Date.now; Date.now = () => real() + 3 * 3600 * 1000; // server B's clock is 3 hours fast
    try { const a = (await A.tryAcquire('skew', 5000))!; expect(await B.tryAcquire('skew', 5000)).toBeNull(); await A.release(a); } finally { Date.now = real; }
  });

  it('a lease that outlives its holder (crash) frees itself after the TTL', async () => {
    await A.tryAcquire('crash', 300); // never released
    expect(await B.tryAcquire('crash', 300)).toBeNull();
    clock.advance(300);
    expect(await B.tryAcquire('crash', 300)).not.toBeNull();
  });
});
