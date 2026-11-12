/* eslint-disable prettier/prettier */
/**
 * A/B experiments: pure bucketing / validation / statistics, then the service on a real MongoDB (direct calls).
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit experiments.integration
 */
import mongoose, { Connection } from 'mongoose';
import { ExperimentSchema } from './experiment.schema';
import { ExperimentsService } from './experiments.service';
import { assignVariant, cleanOverrides, validateExperiment, verdict, zTest } from './experiments.util';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const vid = (i: number) => `visitor-${String(i).padStart(8, '0')}`;
const EXP = 'a'.repeat(24);

describe('bucketing (pure)', () => {
  it('a visitor always gets the same answer', () => {
    for (let i = 0; i < 50; i++) { const a = assignVariant(EXP, vid(i), 60, 50); for (let k = 0; k < 5; k++) expect(assignVariant(EXP, vid(i), 60, 50)).toBe(a); }
  });
  it('traffic and split shares come out right over many visitors', () => {
    let entered = 0; let b = 0;
    for (let i = 0; i < 20000; i++) { const v = assignVariant(EXP, vid(i), 30, 50); if (v) { entered++; if (v === 'b') b++; } }
    expect(entered / 20000).toBeGreaterThan(0.28); expect(entered / 20000).toBeLessThan(0.32);
    expect(b / entered).toBeGreaterThan(0.47); expect(b / entered).toBeLessThan(0.53);
  });
  it('raising the traffic never drops anyone, and never moves an entered visitor to the other variant', () => {
    for (let i = 0; i < 3000; i++) {
      const low = assignVariant(EXP, vid(i), 20, 50); const high = assignVariant(EXP, vid(i), 80, 50);
      if (low) expect(high).toBe(low);
    }
  });
  it('different experiments bucket the same visitor independently', () => {
    let same = 0; const other = 'b'.repeat(24);
    for (let i = 0; i < 4000; i++) if (assignVariant(EXP, vid(i), 100, 50) === assignVariant(other, vid(i), 100, 50)) same++;
    expect(same / 4000).toBeGreaterThan(0.45); expect(same / 4000).toBeLessThan(0.55);
  });
});

describe('overrides + validation (pure)', () => {
  it('only plain values under simple keys; no structure, markup or operator keys', () => {
    expect(cleanOverrides('section', { heading: 'Big sale', columns: 3, showTimer: true }).ok).toBe(true);
    for (const bad of [{}, null, [], { type: 'x' }, { blocks: 'x' }, { customCss: 'a' }, { $where: '1' }, { 'a.b': 'x' }, { heading: '<script>' }, { heading: { x: 1 } }, { heading: 'x'.repeat(501) }, { a__b: 'x' }]) expect(cleanOverrides('section', bad as any).ok).toBe(false);
    expect(cleanOverrides('theme_settings', { 'custom.toastStyle': 'light' }).ok).toBe(true);
    expect(cleanOverrides('theme_settings', { heading: 'x' }).ok).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect(cleanOverrides('section', many).ok).toBe(false);
  });
  it('validates the whole experiment', () => {
    const ok = { kind: 'section', name: 'Hero text', sectionId: EXP, overrides: { heading: 'New' }, trafficPercent: 50, splitB: 50 };
    expect(validateExperiment(ok).ok).toBe(true);
    expect(validateExperiment({ ...ok, kind: 'html' }).ok).toBe(false);
    expect(validateExperiment({ ...ok, sectionId: 'nope' }).ok).toBe(false);
    expect(validateExperiment({ ...ok, trafficPercent: 0 }).ok).toBe(false);
    expect(validateExperiment({ ...ok, splitB: 100 }).ok).toBe(false);
    expect(validateExperiment({ ...ok, name: ' ' }).ok).toBe(false);
  });
});

describe('statistics (pure)', () => {
  const c = (visits: number, orders: number) => ({ visits, addedToCart: 0, reachedCheckout: 0, orders });
  it('says nothing without enough data', () => {
    expect(verdict(c(50, 5), c(50, 9)).verdict).toBe('not_enough_data');
    expect(verdict(c(500, 2), c(500, 3)).verdict).toBe('not_enough_data');
  });
  it('flags a clear winner, ignores noise', () => {
    const clear = verdict(c(2000, 60), c(2000, 120));
    expect(clear.verdict).toBe('likely'); expect(clear.leader).toBe('b');
    expect(verdict(c(2000, 120), c(2000, 60)).leader).toBe('a');
    expect(verdict(c(1000, 50), c(1000, 51)).verdict).toBe('inconclusive');
    expect(zTest({ n: 1000, x: 50 }, { n: 1000, x: 50 })?.p).toBeGreaterThan(0.99);
  });
});

d('experiments service (real Mongo, direct calls)', () => {
  let conn: Connection; let m: any; let svc: ExperimentsService;
  const seller = { id: 'sel1', role: 'seller' };
  const A = 'a1'.repeat(12); const B = 'b2'.repeat(12);
  const S1 = 'c3'.repeat(12); const S2 = 'd4'.repeat(12);
  const body = (extra: any = {}) => ({ kind: 'section', name: 'Hero', sectionId: S1, overrides: { heading: 'New heading' }, trafficPercent: 100, splitB: 50, ...extra });

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `exp_it_${Date.now()}` }).asPromise();
    m = { exps: conn.model('Experiment', ExperimentSchema), sessions: conn.model('StorefrontSession', new mongoose.Schema({}, { strict: false })) };
    await m.exps.init();
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });
  beforeEach(async () => {
    for (const x of Object.values(m) as any[]) await x.deleteMany({});
    svc = new ExperimentsService(m.exps, { repositories: { storefrontSessionModel: m.sessions, storeModel: {} } } as any, { log: jest.fn().mockResolvedValue(undefined) } as any);
  });
  const mk = async (extra: any = {}, store = A) => svc.create(store, seller, body(extra)) as any;
  const run = async (extra: any = {}, store = A) => { const e = await mk(extra, store); await svc.transition(store, seller, String(e._id), 'start'); return e; };

  it('experiments are per store: other stores cannot list, edit, start, stop, delete or read results', async () => {
    const e = await mk();
    expect(await svc.list(B)).toHaveLength(0);
    await expect(svc.update(B, seller, String(e._id), { name: 'x' })).rejects.toThrow(/not found/i);
    await expect(svc.transition(B, seller, String(e._id), 'start')).rejects.toThrow(/not found/i);
    await expect(svc.remove(B, seller, String(e._id))).rejects.toThrow(/not found|running/i);
    await expect(svc.results(B, String(e._id))).rejects.toThrow(/not found/i);
    await expect(svc.applyWinner(B, seller, String(e._id), 'b')).rejects.toThrow();
    expect(await m.exps.countDocuments({ storeId: A })).toBe(1);
  });

  it('only a draft is editable; start/pause/resume/stop are conditional; a running one cannot be deleted', async () => {
    const e = await mk();
    await svc.update(A, seller, String(e._id), { name: 'Renamed', splitB: 30 });
    await svc.transition(A, seller, String(e._id), 'start');
    await expect(svc.update(A, seller, String(e._id), { name: 'x' })).rejects.toThrow(/draft/);
    await expect(svc.transition(A, seller, String(e._id), 'start')).rejects.toThrow(/cannot be started/);
    await expect(svc.remove(A, seller, String(e._id))).rejects.toThrow();
    await svc.transition(A, seller, String(e._id), 'pause');
    await expect(svc.transition(A, seller, String(e._id), 'pause')).rejects.toThrow(/cannot be paused/);
    await svc.transition(A, seller, String(e._id), 'resume');
    await svc.transition(A, seller, String(e._id), 'stop');
    await expect(svc.transition(A, seller, String(e._id), 'resume')).rejects.toThrow();
    await expect(svc.remove(A, seller, String(e._id))).resolves.toMatchObject({ success: true });
  });

  it('limits: 10 per store, 3 running, one running per section, one running theme test', async () => {
    await run({ sectionId: S1 });
    await expect(run({ sectionId: S1, name: 'Same section' })).rejects.toThrow(/already running on this section/);
    await run({ sectionId: S2, name: 'Second' });
    await run({ kind: 'theme_settings', sectionId: undefined, overrides: { 'custom.toastStyle': 'light' }, name: 'Theme' });
    await expect(run({ sectionId: 'e5'.repeat(12), name: 'Fourth' })).rejects.toThrow(/At most 3/);
    await m.exps.insertMany(Array.from({ length: 10 }, (_, i) => ({ storeId: B, name: `d${i}`, kind: 'section', status: 'draft', sectionId: S1, overrides: { a: 'b' } })));
    await expect(mk({}, B)).rejects.toThrow(/At most 10/);
  });

  it('assignments: nothing without a valid visitor id; stable a/b when running; paused/draft/other store give nothing', async () => {
    const e = await run();
    expect(await svc.assignments(A, '')).toEqual([]);
    expect(await svc.assignments(A, 'x')).toEqual([]);
    expect(await svc.assignments(B, vid(1))).toEqual([]);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const r = await svc.assignments(A, vid(i));
      expect(r).toHaveLength(1);
      expect(await svc.assignments(A, vid(i))).toEqual(r);
      expect(r[0].sectionId).toBe(S1);
      expect(r[0].variant === 'b' ? r[0].overrides : r[0].overrides).toEqual(r[0].variant === 'b' ? { heading: 'New heading' } : {});
      seen.add(r[0].variant);
    }
    expect(seen).toEqual(new Set(['a', 'b']));
    await svc.transition(A, seller, String(e._id), 'pause');
    expect(await svc.assignments(A, vid(1))).toEqual([]);
  });

  it('exposure: the server decides the variant and writes it once on that visit; other stores/visitors/experiments are refused', async () => {
    const e = await run(); const id = String(e._id);
    await m.sessions.create([{ storeId: A, sessionId: 'sess-aaaaaaaa', visitorId: vid(1) }, { storeId: B, sessionId: 'sess-bbbbbbbb', visitorId: vid(1) }]);
    const expected = (await svc.assignments(A, vid(1)))[0].variant;
    expect(await svc.recordExposure(A, { sessionId: 'sess-aaaaaaaa', visitorId: vid(1), experimentId: id })).toEqual({ recorded: true });
    expect(await svc.recordExposure(A, { sessionId: 'sess-aaaaaaaa', visitorId: vid(1), experimentId: id })).toEqual({ recorded: false });
    const s: any = await m.sessions.findOne({ sessionId: 'sess-aaaaaaaa' }).lean();
    expect(s.experiments).toEqual([{ experimentId: id, variant: expected }]);
    expect(await svc.recordExposure(B, { sessionId: 'sess-bbbbbbbb', visitorId: vid(1), experimentId: id })).toEqual({ recorded: false });
    expect(await svc.recordExposure(A, { sessionId: 'sess-aaaaaaaa', visitorId: vid(2), experimentId: id })).toEqual({ recorded: false }); // wrong visitor for that visit
    expect(await svc.recordExposure(A, { sessionId: 'sess-aaaaaaaa', visitorId: vid(1), experimentId: 'f6'.repeat(12) })).toEqual({ recorded: false });
    expect(await svc.recordExposure(A, { sessionId: 'bad', visitorId: vid(1), experimentId: id })).toEqual({ recorded: false });
    expect(((await m.sessions.findOne({ sessionId: 'sess-bbbbbbbb' }).lean()) as any).experiments ?? []).toHaveLength(0);
  });

  it('results count only exposed visits, per variant, with the funnel flags as goals; another store sees nothing', async () => {
    const e = await run(); const id = String(e._id);
    const mkS = (n: number, variant: string, flags: any) => ({ storeId: A, sessionId: `sess-${variant}-${String(n).padStart(6, '0')}`, visitorId: vid(n), experiments: [{ experimentId: id, variant }], ...flags });
    await m.sessions.insertMany([
      mkS(1, 'a', { addedToCart: true }), mkS(2, 'a', {}), mkS(3, 'a', { addedToCart: true, reachedCheckout: true, converted: true }),
      mkS(4, 'b', { addedToCart: true, reachedCheckout: true, converted: true }), mkS(5, 'b', { addedToCart: true }),
      { storeId: A, sessionId: 'sess-noexposure-1', visitorId: vid(99), addedToCart: true, reachedCheckout: true, converted: true }, // converted but never in the test
    ]);
    const r: any = await svc.results(A, id);
    expect(r.variants.a).toMatchObject({ visits: 3, addedToCart: 2, reachedCheckout: 1, orders: 1, conversionRate: 33.33 });
    expect(r.variants.b).toMatchObject({ visits: 2, addedToCart: 2, reachedCheckout: 1, orders: 1, conversionRate: 50 });
    expect(r.verdict).toBe('not_enough_data');
    const other: any = await mk({}, B);
    const ro: any = await svc.results(B, String(other._id));
    expect(ro.variants.a.visits + ro.variants.b.visits).toBe(0);
  });

  it('enough data gives a verdict; stop + winner b is served to everyone (even without a visitor id), winner a is not', async () => {
    const e = await run(); const id = String(e._id);
    const rows: any[] = [];
    for (let i = 0; i < 400; i++) rows.push({ storeId: A, sessionId: `sess-a-${String(i).padStart(6, '0')}`, visitorId: vid(i), experiments: [{ experimentId: id, variant: 'a' }], converted: i < 20 });
    for (let i = 0; i < 400; i++) rows.push({ storeId: A, sessionId: `sess-b-${String(i).padStart(6, '0')}`, visitorId: vid(1000 + i), experiments: [{ experimentId: id, variant: 'b' }], converted: i < 60 });
    await m.sessions.insertMany(rows);
    const r: any = await svc.results(A, id);
    expect(r.verdict).toBe('likely'); expect(r.leader).toBe('b');
    await expect(svc.applyWinner(A, seller, id, 'b')).rejects.toThrow(/Stop the experiment first/);
    await svc.transition(A, seller, id, 'stop');
    await expect(svc.applyWinner(A, seller, id, 'x')).rejects.toThrow(/a or b/);
    await svc.applyWinner(A, seller, id, 'b');
    await expect(svc.applyWinner(A, seller, id, 'a')).rejects.toThrow();
    expect(await svc.assignments(A, '')).toEqual([{ experimentId: id, kind: 'section', sectionId: S1, variant: 'winner', overrides: { heading: 'New heading' } }]);
    expect(await svc.assignments(B, '')).toEqual([]);
    const e2 = await run({ sectionId: S2, name: 'Other' }); await svc.transition(A, seller, String(e2._id), 'stop'); await svc.applyWinner(A, seller, String(e2._id), 'a');
    expect((await svc.assignments(A, '')).map((x) => x.experimentId)).toEqual([id]);
  });
});
