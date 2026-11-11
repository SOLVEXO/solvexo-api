/* eslint-disable prettier/prettier */
import * as fs from 'fs';
import * as path from 'path';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';
import { PlatformComplianceService } from './platform-compliance.service';
import { LIVE_CONFIRMATION, reconcileState, rulePackHash, complianceAllowsProduction } from './platform-compliance.util';
import { ADAPTER_VERSIONS } from '../tax-core/adapter-versions';
import { assertProductionAllowed } from '../fbr-di/fbr-production-lock';
import { fbrTokenFingerprint } from '../fbr-di/fbr-di.util';
import { FbrDiService } from '../fbr-di/fbr-di.service';

const TOKEN = 'sandbox-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const SUPER = { userId: 'super1', name: 'owner@solvexo.store' };
const TEAM = { userId: 'team1', teamAdmin: true, name: 'support@solvexo.store' };
/** The invoice-record collection of FbrDiService, with the one aggregate call the settings view makes. */
const records = (): any => { const m: any = new FakeModel(); m.aggregate = async () => []; return m; };
const thrown = async (p: Promise<any>): Promise<string> => { try { await p; return ''; } catch (e: any) { return `${e?.status ?? ''}|${e?.message ?? e}`; } };

function make() {
  const model: any = new FakeModel();
  model.unique = ['subjectType', 'subjectId'];
  const rules: any = new FakeModel();
  const state = { ntn: '1234567', strn: '' };
  const entities: any = {
    load: async () => ({
      entity: { entityKey: 'solvexo-platform', country: 'PK', registrations: [ ...(state.ntn ? [{ country: 'PK', type: 'NTN', number: state.ntn, authority: 'PK_FBR' }] : []), ...(state.strn ? [{ country: 'PK', type: 'STRN', number: state.strn, authority: 'PK_FBR' }] : []) ] },
      rules: [], settings: {},
    }),
  };
  const logs: any[] = [];
  const service = new (PlatformComplianceService as any)(model, rules, entities, { log: (x: any) => logs.push(x) });
  return { service: service as PlatformComplianceService, model, rules, state, logs };
}

/** Walks the happy path up to a given state. */
async function climb(m: ReturnType<typeof make>, to: 'researched' | 'rules_verified' | 'sandbox_tested' | 'live_approved') {
  await m.service.markResearched(SUPER, { source: 'FBR notification 2026' });
  if (to === 'researched') return;
  await m.service.upsertRule(SUPER, { country: 'PK', treatment: 'taxable', ratePercent: 18, source: 'Sales Tax Act, schedule', accountantName: 'A. Khan, FCA' });
  await m.service.verifyRules(SUPER, { source: 'Accountant memo 2026-11', accountantName: 'A. Khan, FCA' });
  if (to === 'rules_verified') return;
  await m.service.recordSandboxTest(true, fbrTokenFingerprint(TOKEN));
  if (to === 'sandbox_tested') return;
  await m.service.approveLive(SUPER, { confirmation: LIVE_CONFIRMATION });
}

describe('compliance: the state machine only goes up by a Super Admin, step by step', () => {
  beforeEach(() => { process.env.FBR_DI_TOKEN_SANDBOX = TOKEN; });

  it('starts as unsupported and walks researched -> rules_verified -> sandbox_tested -> live_approved', async () => {
    const m = make();
    expect((await m.service.getState()).state).toBe('unsupported');
    await climb(m, 'researched'); expect((await m.service.getState()).state).toBe('researched');
    const m2 = make(); await climb(m2, 'rules_verified'); expect((await m2.service.getState()).state).toBe('rules_verified');
    const m3 = make(); await climb(m3, 'sandbox_tested'); expect((await m3.service.getState()).state).toBe('sandbox_tested');
    const m4 = make(); await climb(m4, 'live_approved');
    const s = await m4.service.getState();
    expect(s.state).toBe('live_approved');
    expect(s.liveApprovedBy).toBe('super1');
    expect(s.liveApprovedAt instanceof Date).toBe(true);
  });

  it('AC4.5 every move is in the history with who, when, source and accountant', async () => {
    const m = make(); await climb(m, 'live_approved');
    const h = (await m.service.getState()).history.reverse();
    expect(h.map((x: any) => `${x.from}>${x.to}`)).toEqual(['unsupported>researched', 'researched>rules_verified', 'rules_verified>sandbox_tested', 'sandbox_tested>live_approved']);
    expect(h[0]).toMatchObject({ by: 'super1', byName: 'owner@solvexo.store', source: 'FBR notification 2026', auto: false });
    expect(h[1]).toMatchObject({ source: 'Accountant memo 2026-11', accountantName: 'A. Khan, FCA' });
    expect(h[2]).toMatchObject({ by: 'system', auto: true });
    expect(h.every((x: any) => x.at instanceof Date)).toBe(true);
  });

  it('cannot skip a step', async () => {
    const m = make();
    expect(await thrown(m.service.verifyRules(SUPER, { source: 's', accountantName: 'a' }))).toContain('researched first');
    expect(await thrown(m.service.approveLive(SUPER, { confirmation: LIVE_CONFIRMATION }))).toContain('sandbox test');
    await climb(m, 'researched');
    expect(await thrown(m.service.approveLive(SUPER, { confirmation: LIVE_CONFIRMATION }))).toContain('sandbox test');
    expect(await thrown(m.service.markResearched(SUPER, { source: 'again' }))).toContain('already');
  });

  it('every step needs its evidence: source, accountant, a verified rule, a registration number, the exact phrase', async () => {
    const m = make();
    expect(await thrown(m.service.markResearched(SUPER, { source: '   ' }))).toContain('where the research comes from');
    await m.service.markResearched(SUPER, { source: 'FBR notification 2026' });
    expect(await thrown(m.service.verifyRules(SUPER, { source: 's', accountantName: 'a' }))).toContain('at least one verified rule');
    expect(await thrown(m.service.upsertRule(SUPER, { country: 'PK', treatment: 'taxable', ratePercent: 18, source: '', accountantName: 'a' }))).toContain('source');
    expect(await thrown(m.service.upsertRule(SUPER, { country: 'PK', treatment: 'taxable', ratePercent: 18, source: 's', accountantName: '' }))).toContain('accountant');
    await m.service.upsertRule(SUPER, { country: 'PK', treatment: 'taxable', ratePercent: 18, source: 's', accountantName: 'a' });
    expect(await thrown(m.service.verifyRules(SUPER, { source: '', accountantName: 'a' }))).toContain('source');
    expect(await thrown(m.service.verifyRules(SUPER, { source: 's', accountantName: ' ' }))).toContain('accountant');
    m.state.ntn = '';
    expect(await thrown(m.service.verifyRules(SUPER, { source: 's', accountantName: 'a' }))).toContain('NTN');
    m.state.ntn = '1234567';
    await m.service.verifyRules(SUPER, { source: 's', accountantName: 'a' });
    await m.service.recordSandboxTest(true, fbrTokenFingerprint(TOKEN));
    expect(await thrown(m.service.approveLive(SUPER, { confirmation: 'approve live' }))).toContain('exactly');
    expect(await thrown(m.service.approveLive(SUPER, { confirmation: '' }))).toContain('exactly');
  });

  it('rule validation: a taxable rule needs a rate, anything else must not carry one, country and treatment are checked', async () => {
    const m = make();
    const base = { country: 'PK', source: 's', accountantName: 'a' };
    expect(await thrown(m.service.upsertRule(SUPER, { ...base, treatment: 'taxable' }))).toContain('rate');
    expect(await thrown(m.service.upsertRule(SUPER, { ...base, treatment: 'taxable', ratePercent: 0 }))).toContain('rate');
    expect(await thrown(m.service.upsertRule(SUPER, { ...base, treatment: 'exempt', ratePercent: 5 }))).toContain('Only a taxable');
    expect(await thrown(m.service.upsertRule(SUPER, { ...base, country: 'PAK', treatment: 'exempt' }))).toContain('2-letter');
    expect(await thrown(m.service.upsertRule(SUPER, { ...base, treatment: 'free' }))).toContain('Unknown');
    await m.service.upsertRule(SUPER, { ...base, treatment: 'exempt' });
    expect(m.rules.rows[0]).toMatchObject({ treatment: 'exempt', ratePercent: null, country: 'PK', verification: { state: 'verified', source: 's', accountantName: 'a', verifiedBy: 'super1' } });
  });

  it('a sandbox test that FAILS, or runs in the wrong state, changes nothing', async () => {
    const m = make(); await climb(m, 'researched');
    expect((await m.service.recordSandboxTest(true, fbrTokenFingerprint(TOKEN))).changed).toBe(false); // rules not verified yet
    const m2 = make(); await climb(m2, 'rules_verified');
    expect((await m2.service.recordSandboxTest(false, fbrTokenFingerprint(TOKEN))).changed).toBe(false);
    expect((await m2.service.recordSandboxTest(true, null)).changed).toBe(false);
    expect((await m2.service.getState()).state).toBe('rules_verified');
  });

  it('live approval can be withdrawn and goes back to sandbox_tested, with who and why', async () => {
    const m = make(); await climb(m, 'live_approved');
    await m.service.revokeLive(SUPER, { note: 'accountant asked to pause' });
    const s = await m.service.getState();
    expect(s.state).toBe('sandbox_tested');
    expect(s.liveApprovedAt).toBe(null);
    expect(s.history[0]).toMatchObject({ from: 'live_approved', to: 'sandbox_tested', by: 'super1', note: 'accountant asked to pause' });
  });
});

describe('AC4.3 a team admin can read but never verify or approve', () => {
  beforeEach(() => { process.env.FBR_DI_TOKEN_SANDBOX = TOKEN; });
  it('403 on every mutation, even with every other condition met; reads work', async () => {
    const m = make(); await climb(m, 'sandbox_tested');
    const msgs = await Promise.all([
      thrown(m.service.markResearched(TEAM, { source: 's' })),
      thrown(m.service.upsertRule(TEAM, { country: 'PK', treatment: 'exempt', source: 's', accountantName: 'a' })),
      thrown(m.service.verifyRules(TEAM, { source: 's', accountantName: 'a' })),
      thrown(m.service.approveLive(TEAM, { confirmation: LIVE_CONFIRMATION })),
      thrown(m.service.revokeLive(TEAM, {})),
    ]);
    expect(msgs.every((x) => x.startsWith('403|'))).toBe(true);
    expect((await m.service.getState()).state).toBe('sandbox_tested'); // untouched
  });
});

describe('AC4.2 the state falls by itself when what it rests on changes (and never rises by itself)', () => {
  beforeEach(() => { process.env.FBR_DI_TOKEN_SANDBOX = TOKEN; });
  const OLD_ADAPTER = ADAPTER_VERSIONS.PK_FBR;
  afterEach(() => { ADAPTER_VERSIONS.PK_FBR = OLD_ADAPTER; process.env.FBR_DI_TOKEN_SANDBOX = TOKEN; });

  it('registration number changed -> researched', async () => {
    const m = make(); await climb(m, 'live_approved');
    m.state.ntn = '7654321';
    const s = await m.service.getState();
    expect(s.state).toBe('researched');
    expect(s.liveApprovedAt).toBe(null);
    expect(s.history[0]).toMatchObject({ from: 'live_approved', to: 'researched', auto: true, by: 'system' });
    expect(s.history[0].note).toContain('registration');
  });

  it('adding the STRN is also a registration change', async () => {
    const m = make(); await climb(m, 'rules_verified');
    m.state.strn = '99-00-1';
    expect((await m.service.getState()).state).toBe('researched');
  });

  it('a verified rule changed (new rate) -> researched, and the old state does not come back by itself', async () => {
    const m = make(); await climb(m, 'live_approved');
    await m.service.upsertRule(SUPER, { country: 'PK', treatment: 'taxable', ratePercent: 17, source: 'new notice', accountantName: 'A. Khan, FCA' });
    expect((await m.service.getState()).state).toBe('researched');
    await m.service.upsertRule(SUPER, { country: 'PK', treatment: 'taxable', ratePercent: 18, source: 'old notice again', accountantName: 'A. Khan, FCA' }); // back to the original pack
    expect((await m.service.getState()).state).toBe('researched'); // still needs a person
  });

  it('adapter version changed -> rules_verified (must be tested again)', async () => {
    const m = make(); await climb(m, 'live_approved');
    ADAPTER_VERSIONS.PK_FBR = 'pral-di-1.13/next';
    const s = await m.service.getState();
    expect(s.state).toBe('rules_verified');
    expect(s.history[0].note).toContain('adapter');
  });

  it('sandbox token changed -> rules_verified', async () => {
    const m = make(); await climb(m, 'live_approved');
    process.env.FBR_DI_TOKEN_SANDBOX = 'another-sandbox-token-bbbbbbbbbbbbbbbb';
    const s = await m.service.getState();
    expect(s.state).toBe('rules_verified');
    expect(s.history[0].note).toContain('token');
  });

  it('AC4.1 live_approved but the token is gone -> falls, so compliance does NOT allow production', async () => {
    const m = make(); await climb(m, 'live_approved');
    expect(await m.service.allowsProduction()).toBe(true);
    delete process.env.FBR_DI_TOKEN_SANDBOX;
    expect(await m.service.allowsProduction()).toBe(false);
    expect((await m.service.getState()).state).toBe('rules_verified');
  });

  it('a change at a lower state only drops as far as needed (sandbox_tested + token change stays above researched)', async () => {
    const m = make(); await climb(m, 'sandbox_tested');
    process.env.FBR_DI_TOKEN_SANDBOX = 'another-sandbox-token-bbbbbbbbbbbbbbbb';
    expect((await m.service.getState()).state).toBe('rules_verified');
  });

  it('nothing changed -> nothing moves', async () => {
    const m = make(); await climb(m, 'live_approved');
    const before = (await m.service.getState()).history.length;
    await m.service.getState(); await m.service.getState();
    expect((await m.service.getState()).history.length).toBe(before);
    expect((await m.service.getState()).state).toBe('live_approved');
  });
});

describe('the compliance record and the hard production lock are separate switches', () => {
  beforeEach(() => { process.env.FBR_DI_TOKEN_SANDBOX = TOKEN; });
  it('AC4.1 even a fully approved record does not open production: the lock is unconditional', async () => {
    const m = make(); await climb(m, 'live_approved');
    expect((await m.service.getState()).complianceAllowsProduction).toBe(true);
    expect((await m.service.getState()).productionLocked).toBe(true);
    expect(assertProductionAllowed()).toBe(false);
  });
  it('the lock file does not read the compliance state at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'fbr-di', 'fbr-production-lock.ts'), 'utf8');
    expect(/compliance/i.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(false);
  });
});

describe('pure rules', () => {
  const snap = (o: any = {}) => ({ registrationNumber: 'NTN:1', rulePackHash: 'h', adapterVersion: 'v1', tokenFingerprint: 'fp', ...o });
  it('reconcileState table', () => {
    expect(reconcileState('live_approved', snap(), snap())).toEqual({ state: 'live_approved', reason: null });
    expect(reconcileState('live_approved', snap(), snap({ registrationNumber: 'NTN:2' })).state).toBe('researched');
    expect(reconcileState('rules_verified', snap(), snap({ rulePackHash: 'x' })).state).toBe('researched');
    expect(reconcileState('sandbox_tested', snap(), snap({ adapterVersion: 'v2' })).state).toBe('rules_verified');
    expect(reconcileState('live_approved', snap(), snap({ tokenFingerprint: 'other' })).state).toBe('rules_verified');
    expect(reconcileState('live_approved', snap(), snap({ tokenFingerprint: null })).state).toBe('rules_verified');
    expect(reconcileState('researched', snap({ rulePackHash: null }), snap({ rulePackHash: 'x' }))).toEqual({ state: 'researched', reason: null });
    expect(reconcileState('unsupported', snap(), snap({ registrationNumber: 'other' })).state).toBe('unsupported'); // never raised, never touched
    // a change that hits two conditions takes the LOWER result
    expect(reconcileState('live_approved', snap(), snap({ registrationNumber: 'z', adapterVersion: 'v9' })).state).toBe('researched');
  });
  it('rulePackHash ignores order and changes with any field', () => {
    const a = { country: 'pk', supplyType: 's', treatment: 'taxable', ratePercent: 18 };
    const b = { country: 'GB', supplyType: 's', treatment: 'exempt', ratePercent: null };
    expect(rulePackHash([a, b])).toBe(rulePackHash([b, a]));
    expect(rulePackHash([a])).not.toBe(rulePackHash([{ ...a, ratePercent: 17 }]));
    expect(rulePackHash([a])).not.toBe(rulePackHash([{ ...a, treatment: 'exempt' }]));
    expect(rulePackHash([])).toBe(rulePackHash([]));
  });
  it('only live_approved allows production by compliance', () => {
    expect((['unsupported', 'researched', 'rules_verified', 'sandbox_tested', 'live_approved'] as const).map(complianceAllowsProduction)).toEqual([false, false, false, false, true]);
  });
});

describe('the passing FBR sandbox test feeds the compliance state', () => {
  it('testPlatform reports a PASSED test with the token fingerprint, and a failed one as not ok', async () => {
    process.env.FBR_DI_TOKEN_SANDBOX = TOKEN; process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'unit-test-key';
    const seen: any[] = [];
    let ok = true;
    const client: any = { validate: async () => ({ result: { ok, invoiceNumber: null, dated: null, errors: ok ? [] : [{ code: '1', message: 'no' }], retryable: false, notSent: false, unknownOutcome: false, authError: false, httpStatus: 200 }, payload: {} }), post: async () => ({}), reference: async () => null };
    const platformTax: any = { getSettings: async () => ({ legalName: 'Solvexo (Pvt) Ltd', ntn: '1234567', strn: '', address: 'Clifton, Karachi', authority: 'FBR' }) };
    const svc = new (FbrDiService as any)(new FakeModel(), new FakeModel(), records(), { repositories: {} }, client, platformTax, { convert: async () => 280 }, { log: () => {} }, undefined, undefined, undefined, undefined, undefined, { recordSandboxTest: async (a: boolean, fp: string) => { seen.push([a, fp]); return { changed: a }; } });
    await svc.updatePlatformSettings({ province: 'SINDH', hsCode: '9815.0000' }, 'a');
    await svc.testPlatform('a');
    ok = false; await svc.testPlatform('a');
    expect(seen).toEqual([[true, fbrTokenFingerprint(TOKEN)], [false, fbrTokenFingerprint(TOKEN)]]);
  });
  it('a compliance failure never breaks the test itself', async () => {
    process.env.FBR_DI_TOKEN_SANDBOX = TOKEN;
    const client: any = { validate: async () => ({ result: { ok: true, invoiceNumber: null, dated: null, errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false, httpStatus: 200 }, payload: {} }), post: async () => ({}), reference: async () => null };
    const platformTax: any = { getSettings: async () => ({ legalName: 'S', ntn: '1234567', strn: '', address: 'K', authority: 'FBR' }) };
    const svc = new (FbrDiService as any)(new FakeModel(), new FakeModel(), records(), { repositories: {} }, client, platformTax, { convert: async () => 280 }, { log: () => {} }, undefined, undefined, undefined, undefined, undefined, { recordSandboxTest: async () => { throw new Error('db down'); } });
    await svc.updatePlatformSettings({ province: 'SINDH', hsCode: '9815.0000' }, 'a');
    const out: any = await svc.testPlatform('a');
    expect(out.ok).toBe(true);
  });
});

describe('AC4.7 compliance is Solvexo-only: nothing on the seller side sees it', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  it('only the admin controller serves it, behind an admin role and a permission on every route', () => {
    const src = read('platform-tax/platform-compliance.controller.ts');
    expect(src.includes("@Roles('admin')")).toBe(true);
    expect(/@Roles\('seller'|@Roles\('staff'/.test(src)).toBe(false);
    const routes = (src.match(/@(Get|Post|Put|Patch|Delete)\(/g) ?? []).length;
    expect((src.match(/@RequirePermission\('billing\.manage'\)/g) ?? []).length).toBe(routes);
    expect(routes).toBeGreaterThan(0);
  });
  it('the seller-facing FBR settings code never touches compliance', () => {
    const svc = read('fbr-di/fbr-di.service.ts');
    const storeSettings = svc.slice(svc.indexOf('async getStoreSettings'), svc.indexOf('async updateStoreSettings'));
    expect(/compliance/i.test(storeSettings)).toBe(false);
    const ctl = read('fbr-di/fbr-di.controller.ts');
    expect(/compliance/i.test(ctl)).toBe(false);
  });
  it('no other module registers the compliance collection or service', () => {
    const files = ['store/store.module.ts', 'fbr-di/fbr-di.module.ts'];
    for (const f of files) expect(/PlatformComplianceService|PlatformTaxCompliance/.test(read(f))).toBe(false);
  });
});
