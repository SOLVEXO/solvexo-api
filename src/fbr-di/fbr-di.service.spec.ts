/* eslint-disable prettier/prettier */
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';
import { FbrDiClient } from './fbr-di.client';
import { FbrDiService } from './fbr-di.service';
import { NOTIFICATION_CATEGORY, NOTIFICATION_TYPES, SELLER_EMAIL_TYPES } from '../notifications/notification.types';
import { buildPayload, FBR_MAX_ATTEMPTS, FbrResult, interpretResponse, pktDate } from './fbr-di.util';

process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'unit-test-key-for-fbr';
process.env.FBR_DI_TOKEN_SANDBOX = 'sandbox-token-aaaaaaaaaaaaaaaaaaaaaaaa';
delete process.env.FBR_DI_TOKEN_PRODUCTION;

const SANDBOX_TOKEN = 'sandbox-token-aaaaaaaaaaaaaaaaaaaaaaaa';
const NUMBER = '1234567DI1747119701593';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const resultBase: FbrResult = { ok: false, invoiceNumber: null, dated: null, errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false, httpStatus: 200 };
const OK: FbrResult = { ...resultBase, ok: true, invoiceNumber: NUMBER, dated: '2026-11-11 10:00:00' };
const bad = (over: Partial<FbrResult>): FbrResult => ({ ...resultBase, errors: [{ code: '0046', message: 'Provide rate.' }], ...over });
// Realistic outcomes, built by the same parser the real client uses.
const dns = () => interpretResponse(null, null, 'ENOTFOUND', true, true);          // request provably never left
const timeout = () => interpretResponse(null, null, 'timed out waiting for FBR', true, false); // may have arrived
const http503 = () => interpretResponse(503, null);
const garbled = () => interpretResponse(200, '<html>oops</html>');

function make() {
  // The real schema fills these defaults in; the fake has to do the same or filters like `attempts < MAX` / `inFlightAt: null` would never match.
  const platformModel = new FakeModel(); const storeSettings = new FakeModel();
  const invoices: any = new FakeModel({ attempts: 0, errors: [], authError: false, nextAttemptAt: null, fbrInvoiceNumber: null, fbrDated: null, qrText: null, note: null, fxRatePKRPerUSD: null, inFlightAt: null, needsInfoSince: null, notifiedAt: null, resolvedAt: null, resolvedBy: null, resolution: null });
  invoices.unique = ['issuer', 'source', 'sourceId', 'kind'];
  invoices.aggregate = async () => {
    const m = new Map<string, number>(); for (const r of invoices.rows) m.set(r.status, (m.get(r.status) ?? 0) + 1);
    return [...m].map(([_id, n]) => ({ _id, n }));
  };
  const repos: any = {
    platformPlanInvoiceModel: new FakeModel(), platformPlanModel: new FakeModel(), storeModel: new FakeModel(), sellerModel: new FakeModel(),
    orderModel: new FakeModel(), productVariantModel: new FakeModel(),
  };
  repos.platformPlanModel.rows.push({ _id: 'plan1', name: 'Grow' });
  repos.storeModel.rows.push({ _id: 'st1', name: 'Ali Store', taxId: '7654321', taxRegistered: true, businessAddress: 'Mall Road, Lahore', country: 'PK', baseCurrency: 'PKR', sellerId: 'sl1', isDelete: false });
  repos.sellerModel.rows.push({ _id: 'sl1', name: 'Ali', address: 'Lahore' });
  repos.productVariantModel.rows.push({ _id: 'v1', hsCode: '6109.1000' });
  const b2b: any = new FakeModel();

  const calls: any[] = [];
  let next: () => FbrResult = () => OK;
  const client: any = {
    post: async (input: any, mode: string, token: string) => { calls.push({ input, mode, token }); return { result: next(), payload: buildPayload(input, mode as any) }; },
    validate: async (input: any, mode: string, token: string) => { calls.push({ input, mode, token, validate: true }); return { result: next(), payload: {} }; },
    reference: async () => null,
  };
  const alerts: any[] = []; const notes: any[] = [];
  const notifications: any = { notifyAdmins: async (p: any) => { alerts.push(p); }, notify: async (p: any) => { notes.push(p); } };
  const platformTax: any = { getSettings: async () => ({ legalName: 'Solvexo (Pvt) Ltd', ntn: '1234567', strn: '', address: 'Clifton, Karachi', authority: 'FBR' }) };
  const exchangeRate: any = { convert: async () => 280 };
  const logs: any[] = [];
  const service = new (FbrDiService as any)(platformModel, storeSettings, invoices, { repositories: repos }, client, platformTax, exchangeRate, { log: (x: any) => logs.push(x) }, notifications, b2b);
  return { service, platformModel, storeSettings, invoices, repos, b2b, calls, alerts, notes, logs, setNext: (f: () => FbrResult) => { next = f; } };
}

async function enablePlatform(m: ReturnType<typeof make>) {
  await m.service.updatePlatformSettings({ enabled: true, province: 'SINDH', hsCode: '9815.0000' }, 'admin1');
  // a buyer province, so the plan invoice is complete
  await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: 'PUNJAB' }, $setOnInsert: { storeId: 'st1' } }, { upsert: true });
}
const planInvoice = (over: any = {}) => ({ _id: 'pi1', storeId: 'st1', sellerId: 'sl1', platformPlanId: 'plan1', invoiceNumber: 'PINV-202611-000001', status: 'paid', type: 'recurring', amountUSD: 59, subtotalUSD: 50, taxAmountUSD: 9, taxRatePercent: 18, taxCountry: 'PK', paidAt: new Date(Date.now() + 1000), isDelete: false, ...over });
/** Makes a record due again (the real clock would take minutes/hours). */
const makeDue = (rec: any) => { rec.nextAttemptAt = new Date(Date.now() - 1000); };
const thrown = async (p: Promise<any>): Promise<string> => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };

describe('FbrDiService — Solvexo plan invoices', () => {
  // CHANGED ON PURPOSE (Phase 0): production is hard-locked, so it is refused whether or not a token exists.
  it('cannot be switched on without a sandbox token', async () => {
    const m = make();
    delete process.env.FBR_DI_TOKEN_SANDBOX;
    const msg = await thrown(m.service.updatePlatformSettings({ enabled: true }, 'a'));
    process.env.FBR_DI_TOKEN_SANDBOX = SANDBOX_TOKEN;
    expect(msg.includes('FBR_DI_TOKEN_SANDBOX')).toBe(true);
  });

  it('starts reporting from the moment it is switched on, never backwards', async () => {
    const m = make();
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ _id: 'old', paidAt: new Date(Date.now() - 5 * DAY) }));
    await enablePlatform(m);
    expect(await m.service.syncPlatform()).toBe(0); // the old paid invoice is before enabledSince
  });

  // CHANGED ON PURPOSE (Phase 0): an untaxed invoice used to be 'skipped'; it is now HELD (never skipped, never zero, never sent).
  it('queues Pakistani-tax invoices, HOLDS everything else, and never queues twice', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ _id: 'pi2', invoiceNumber: 'PINV-2', taxAmountUSD: 0, taxRatePercent: 0, amountUSD: 50 }));
    expect(await m.service.syncPlatform()).toBe(2);
    expect(await m.service.syncPlatform()).toBe(0);
    const byId: any = {}; m.invoices.rows.forEach((r: any) => (byId[r.sourceId] = r));
    expect(byId.pi1.status).toBe('pending');
    expect(byId.pi2.status).toBe('held_rule');
  });

  it('files the invoice in rupees at ONE frozen rate and stores the FBR number', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    const out: any = await m.service.processDue();
    expect(out.submitted).toBe(1);
    const sent = m.calls[0];
    expect(sent.mode).toBe('sandbox');
    expect(sent.token).toBe(SANDBOX_TOKEN);
    expect(sent.input.sellerNTNCNIC).toBe('1234567');
    expect(sent.input.sellerBusinessName).toBe('Solvexo (Pvt) Ltd');
    expect(sent.input.buyerRegistrationType).toBe('Registered');
    expect(sent.input.buyerNTNCNIC).toBe('7654321');
    expect(sent.input.buyerProvince).toBe('PUNJAB');
    expect(sent.input.items[0].valueSalesExcludingST).toBe(14000); // 50 USD * 280
    expect(sent.input.items[0].salesTaxApplicable).toBe(2520);     // 9 USD * 280
    expect(sent.input.items[0].totalValues).toBe(16520);
    expect(sent.input.items[0].rate).toBe('18%');
    expect(sent.input.items[0].hsCode).toBe('9815.0000');
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('submitted');
    expect(rec.fbrInvoiceNumber).toBe(NUMBER);
    expect(rec.qrText).toBe(NUMBER);
    expect(rec.fxRatePKRPerUSD).toBe(280);
    expect(rec.attempts).toBe(1);
    expect(rec.inFlightAt).toBe(null);
    // nothing is sent twice
    await m.service.processDue();
    expect(m.calls.length).toBe(1);
  });

  it('dates the invoice with the Pakistani calendar date of the supply (paid at 00:30 Karachi on the 11th, still the 10th in UTC)', async () => {
    const m = make(); await enablePlatform(m);
    // paidAt must be after "enabledSince" (now), so use a future instant and compute the expectation the same way the code does
    const paidAt = new Date(Date.now() + 60_000);
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ paidAt }));
    await m.service.syncPlatform(); await m.service.processDue();
    expect(m.calls[0].input.invoiceDate).toBe(pktDate(paidAt));
    expect(/^\d{4}-\d{2}-\d{2}$/.test(m.calls[0].input.invoiceDate)).toBe(true);
  });

  it('the sandbox test dates its sample invoice with the Pakistani date too', async () => {
    const m = make(); await enablePlatform(m);
    await m.service.testPlatform('admin1');
    expect(m.calls[0].validate).toBe(true);
    expect(m.calls[0].input.invoiceDate).toBe(pktDate(new Date()));
  });

  it('asks for the missing buyer province (needs_info), then files after it is added', async () => {
    const m = make(); await enablePlatform(m);
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: '' } });
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform(); await m.service.processDue();
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('needs_info');
    expect(rec.errors[0].message.includes('Buyer province')).toBe(true);
    expect(rec.errors[0].message.includes('FBR digital invoicing')).toBe(true);
    expect(m.calls.length).toBe(0);
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: 'SINDH' } });
    const done: any = await m.service.retry(rec._id, { issuer: 'platform' });
    expect(done.status).toBe('submitted');
    expect(m.calls.length).toBe(1);
  });

  it('marks an unregistered store as Unregistered with no buyer NTN', async () => {
    const m = make(); await enablePlatform(m);
    m.repos.storeModel.rows[0].taxRegistered = false;
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform(); await m.service.processDue();
    expect(m.calls[0].input.buyerRegistrationType).toBe('Unregistered');
    expect('buyerNTNCNIC' in m.calls[0].input && !!m.calls[0].input.buyerNTNCNIC).toBe(false);
  });

  it('REJECTED by FBR: no automatic retry, the admin is told once, manual retry works after the fix', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    m.setNext(() => bad({}));
    await m.service.syncPlatform(); await m.service.processDue();
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('rejected');
    expect(rec.nextAttemptAt).toBe(null);
    expect(rec.errors[0].code).toBe('0046');
    expect(m.alerts.length).toBe(1);
    await m.service.processDue();
    expect(m.calls.length).toBe(1); // not retried by itself
    m.setNext(() => OK);
    const done: any = await m.service.retry(rec._id, { issuer: 'platform' });
    expect(done.status).toBe('submitted');
    expect(m.alerts.length).toBe(1); // no second alert for the same record
  });

  it('token error: stops (no pointless retries), flagged as authError, admin alerted', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    m.setNext(() => bad({ authError: true, httpStatus: 401, errors: [{ code: '401', message: 'unauthorized' }] }));
    await m.service.syncPlatform(); await m.service.processDue();
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('failed');
    expect(rec.authError).toBe(true);
    expect(rec.nextAttemptAt).toBe(null);
    expect(m.alerts.length).toBe(1);
  });

  // CHANGED ON PURPOSE (Phase 0): "FBR down" used to mean 503 => retry. Now only a request that provably never left (DNS) is retried.
  it('request provably never left (DNS): retried with back-off, gives up after the maximum, telling the admin once', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    m.setNext(dns);
    await m.service.syncPlatform(); await m.service.processDue();
    let rec = m.invoices.rows[0];
    expect(rec.status).toBe('failed');
    expect(rec.attempts).toBe(1);
    const waitMin = (new Date(rec.nextAttemptAt).getTime() - Date.now()) / MIN;
    expect(waitMin > 4 && waitMin <= 5.1).toBe(true); // first back-off is 5 minutes
    expect(m.alerts.length).toBe(0);
    for (let i = 1; i < FBR_MAX_ATTEMPTS; i++) { makeDue(rec); await m.service.processDue(); rec = m.invoices.rows[0]; }
    expect(rec.attempts).toBe(FBR_MAX_ATTEMPTS);
    expect(rec.nextAttemptAt).toBe(null);
    expect(m.alerts.length).toBe(1);
  });

  it('DNS failure then success: the retry files it once', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    m.setNext(dns);
    await m.service.syncPlatform(); await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('failed');
    m.setNext(() => OK); makeDue(m.invoices.rows[0]);
    await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('submitted');
    expect(m.calls.length).toBe(2);
  });

  it.each([['timeout', timeout], ['HTTP 503', http503], ['unreadable 200 body', garbled]])('%s => unknown_outcome, NO automatic resend, admin told once', async (_name, outcome) => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    m.setNext(outcome as any);
    await m.service.syncPlatform(); await m.service.processDue();
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('unknown_outcome');
    expect(rec.nextAttemptAt).toBe(null);
    expect(rec.inFlightAt).toBe(null);
    expect(m.alerts.length).toBe(1);
    // however much time passes, it is never resent by itself, and a plain "send again" is refused too
    makeDue(rec); await m.service.processDue(); await m.service.processDue();
    expect(m.calls.length).toBe(1);
    expect((await thrown(m.service.retry(rec._id, { issuer: 'platform' }))).includes('FBR may already have this invoice')).toBe(true);
    expect(m.calls.length).toBe(1);
  });

  it('never posts the same invoice twice when two workers run at once', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    const id = m.invoices.rows[0]._id;
    await Promise.all([m.service.attempt(id), m.service.attempt(id)]);
    expect(m.calls.length).toBe(1);
  });

  it('CRASH after the post but before the answer is saved: on restart NO repost, the record becomes unknown_outcome', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    const id = m.invoices.rows[0]._id;
    const svc: any = m.service; const realFinish = svc.finish.bind(svc);
    svc.finish = async () => { throw new Error('process died'); }; // FBR answered, then the server died before saving
    let crashed = false; try { await svc.attempt(id); } catch { crashed = true; }
    expect(crashed).toBe(true);
    expect(m.calls.length).toBe(1);
    expect(m.invoices.rows[0].inFlightAt instanceof Date).toBe(true); // the in-flight mark survived the crash
    // restart: the lease has long run out
    svc.finish = realFinish;
    m.invoices.rows[0].inFlightAt = new Date(Date.now() - 20 * MIN); makeDue(m.invoices.rows[0]);
    await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('unknown_outcome');
    expect(m.invoices.rows[0].inFlightAt).toBe(null);
    expect(m.calls.length).toBe(1); // NOT resent
    expect(m.alerts.length).toBe(1);
    await m.service.processDue(); await m.service.processDue();
    expect(m.calls.length).toBe(1);
  });

  it('a crash BEFORE anything was sent is a normal failure that retries (the in-flight mark is only set right before the call)', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    const id = m.invoices.rows[0]._id;
    const svc: any = m.service; const real = svc.buildContext.bind(svc);
    svc.buildContext = async () => { throw new Error('db hiccup'); };
    await svc.attempt(id);
    expect(m.calls.length).toBe(0);
    expect(m.invoices.rows[0].status).toBe('failed');
    expect(m.invoices.rows[0].inFlightAt).toBe(null);
    svc.buildContext = real; makeDue(m.invoices.rows[0]);
    await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('submitted');
    expect(m.calls.length).toBe(1);
  });

  it('an in-flight record that is still young (worker alive) is left alone by the sweep', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    m.invoices.rows[0].inFlightAt = new Date(Date.now() - 2 * MIN);
    expect(await m.service.sweepStaleInFlight()).toBe(0);
    expect(m.invoices.rows[0].status).toBe('pending');
  });

  // ── held_rule ──
  it('UK-tax paid invoice => held_rule, 0 FBR calls, NOT skipped, and still held after any number of cycles', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ taxCountry: 'GB', taxRatePercent: 20, taxAmountUSD: 10, amountUSD: 60 }));
    await m.service.runCycle(); await m.service.runCycle();
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('held_rule');
    expect(rec.status === 'skipped').toBe(false);
    expect(String(rec.note).includes('GB')).toBe(true);
    expect(rec.nextAttemptAt).toBe(null);
    expect(m.calls.length).toBe(0);
  });

  it('PK customer with tax 0, empty taxCountry, or unknown tax data => held_rule, never sent, and unknown is not treated as zero', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ _id: 'z0', invoiceNumber: 'Z0', taxAmountUSD: 0, taxRatePercent: 0, amountUSD: 50 }));
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ _id: 'nc', invoiceNumber: 'NC', taxCountry: null }));
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ _id: 'ec', invoiceNumber: 'EC', taxCountry: '' }));
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ _id: 'uk', invoiceNumber: 'UK', subtotalUSD: null, taxAmountUSD: 0, taxRatePercent: 0 }));
    await m.service.runCycle();
    const st: any = {}; m.invoices.rows.forEach((r: any) => (st[r.sourceId] = r));
    for (const id of ['z0', 'nc', 'ec', 'uk']) expect(st[id].status).toBe('held_rule');
    expect(String(st.uk.note).includes('UNKNOWN')).toBe(true);
    expect(m.calls.length).toBe(0);
  });

  it('a record queued as pending under the OLD rule is held (not sent) when it is next processed', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ taxCountry: 'GB' }));
    await m.invoices.create({ issuer: 'platform', source: 'plan_invoice', sourceId: 'pi1', storeId: 'st1', sellerId: 'sl1', kind: 'sale', status: 'pending', mode: 'sandbox', reference: 'PINV-1', nextAttemptAt: new Date(Date.now() - 1000) });
    await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('held_rule');
    expect(m.invoices.rows[0].attempts).toBe(0); // a hold is not an attempt
    expect(m.calls.length).toBe(0);
  });

  it('a held invoice cannot be pushed through with "send again"', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice({ taxCountry: 'GB' }));
    await m.service.runCycle();
    const msg = await thrown(m.service.retry(m.invoices.rows[0]._id, { issuer: 'platform' }));
    expect(msg.includes('on hold')).toBe(true);
    expect(m.calls.length).toBe(0);
  });

  // ── production hard lock ──
  it('production is HARD-LOCKED for the platform: setting it, or switching on while it is the stored mode, is refused (even with a token)', async () => {
    process.env.FBR_DI_TOKEN_PRODUCTION = 'production-token-bbbbbbbbbbbbbbbbbbbb';
    try {
      const m = make();
      expect((await thrown(m.service.updatePlatformSettings({ mode: 'production' }, 'a'))).includes('locked')).toBe(true);
      expect((await thrown(m.service.updatePlatformSettings({ enabled: true, mode: 'production' }, 'a'))).includes('locked')).toBe(true);
      expect(m.platformModel.rows.length).toBe(0); // nothing was written
      // a legacy document that already says production: it cannot be switched on, but it can be switched off
      await m.platformModel.updateOne({ key: 'platform' }, { $set: { mode: 'production', enabled: false }, $setOnInsert: { key: 'platform' } }, { upsert: true });
      expect((await thrown(m.service.updatePlatformSettings({ enabled: true }, 'a'))).includes('locked')).toBe(true);
      expect(await thrown(m.service.updatePlatformSettings({ enabled: false, province: 'SINDH' }, 'a'))).toBe('');
      // the production token is never read, and the UI is told it is locked
      expect(m.service.platformToken('production')).toBe(null);
      const s: any = await m.service.getPlatformSettings();
      expect(s.tokenConfigured.production).toBe(false);
      expect(s.productionLocked).toBe(true);
    } finally { delete process.env.FBR_DI_TOKEN_PRODUCTION; }
  });

  it('a platform record that carries mode=production is never posted: it is held with the lock reason', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    m.invoices.rows[0].mode = 'production';
    await m.service.processDue();
    expect(m.calls.length).toBe(0);
    expect(m.invoices.rows[0].status).toBe('pending');
    expect(String(m.invoices.rows[0].note).includes('locked')).toBe(true);
    expect(m.invoices.rows[0].attempts).toBe(0);
  });

  it('the HTTP client itself refuses production: nothing is sent, the result says "locked"', async () => {
    const realFetch = (global as any).fetch; let fetched = false;
    (global as any).fetch = async () => { fetched = true; throw new Error('fetch must not be called'); };
    try {
      const c = new FbrDiClient();
      const input: any = { invoiceType: 'Sale Invoice', invoiceDate: '2026-11-11', sellerNTNCNIC: '1234567', sellerBusinessName: 'S', sellerProvince: 'SINDH', sellerAddress: 'K', buyerNTNCNIC: null, buyerBusinessName: 'B', buyerProvince: 'SINDH', buyerAddress: 'K', buyerRegistrationType: 'Unregistered', items: [] };
      const post = await c.post(input, 'production', 'x'.repeat(30));
      const val = await c.validate(input, 'production', 'x'.repeat(30));
      expect(post.result.locked).toBe(true);
      expect(post.result.ok).toBe(false);
      expect(val.result.locked).toBe(true);
      expect(fetched).toBe(false);
    } finally { (global as any).fetch = realFetch; }
  });

  it('a "locked" answer from the client holds the record without counting an attempt (defence in depth)', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    m.setNext(() => ({ ...resultBase, errors: [{ code: 'LOCKED', message: 'locked' }], notSent: true, locked: true, httpStatus: null }));
    await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('pending');
    expect(m.invoices.rows[0].attempts).toBe(0);
    expect(m.invoices.rows[0].inFlightAt).toBe(null);
  });

  // ── needs_info runs by itself ──
  it('needs_info is re-checked by itself every hour WITHOUT using attempts, and files as soon as the province is added', async () => {
    const m = make(); await enablePlatform(m);
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: '' } });
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform(); await m.service.processDue();
    let rec = m.invoices.rows[0];
    expect(rec.status).toBe('needs_info');
    const wait = (new Date(rec.nextAttemptAt).getTime() - Date.now()) / MIN;
    expect(wait > 59 && wait <= 60.1).toBe(true);
    expect(rec.needsInfoSince instanceof Date).toBe(true);
    // not due yet: nothing happens
    await m.service.processDue();
    expect(m.invoices.rows[0].attempts).toBe(0);
    // three hourly checks while the province is still missing: attempts stay 0, nothing is sent
    for (let i = 0; i < 3; i++) { makeDue(rec); await m.service.processDue(); rec = m.invoices.rows[0]; }
    expect(rec.attempts).toBe(0);
    expect(rec.status).toBe('needs_info');
    expect(m.calls.length).toBe(0);
    // the seller adds the province; nobody presses anything; the next hourly check sends it
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: 'SINDH' } });
    makeDue(rec); await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('submitted');
    expect(m.calls.length).toBe(1);
  });

  it('needs_info stops being checked after 14 days (a person can still press "Send again")', async () => {
    const m = make(); await enablePlatform(m);
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: '' } });
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform(); await m.service.processDue();
    const rec = m.invoices.rows[0];
    rec.needsInfoSince = new Date(Date.now() - 15 * DAY); makeDue(rec);
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: 'SINDH' } });
    const out: any = await m.service.processDue();
    expect(out.attempted).toBe(0);
    expect(m.calls.length).toBe(0);
    expect(m.invoices.rows[0].status).toBe('needs_info');
    const done: any = await m.service.retry(rec._id, { issuer: 'platform' });
    expect(done.status).toBe('submitted');
  });

  it('flags a refund of a reported invoice for a human instead of filing a note by itself, and explains the 72-hour / 180-day rules', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform(); await m.service.processDue();
    m.repos.platformPlanInvoiceModel.rows[0].refundedAmountUSD = 20; m.repos.platformPlanInvoiceModel.rows[0].status = 'partially_refunded';
    expect(await m.service.syncPlatform()).toBe(1);
    const adj = m.invoices.rows.find((r: any) => r.kind === 'adjustment');
    expect(adj.status).toBe('needs_review');
    expect(adj.note.includes('72 hours')).toBe(true);
    expect(adj.note.includes('180 days')).toBe(true);
    expect(adj.note.includes('accountant')).toBe(true);
    expect(await m.service.syncPlatform()).toBe(0);
    expect(m.calls.length).toBe(1); // still only the original sale was sent
  });

  it('holds (does not count an attempt) while invoicing is switched off', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform();
    await m.service.updatePlatformSettings({ enabled: false }, 'a');
    await m.service.processDue();
    const rec = m.invoices.rows[0];
    expect(rec.status).toBe('pending');
    expect(rec.attempts).toBe(0);
    expect(m.calls.length).toBe(0);
  });

  // ── token / test validity ──
  it('a sandbox test only counts while the platform token is the very one it was run with (fingerprint)', async () => {
    const m = make(); await enablePlatform(m);
    expect((await m.service.getPlatformSettings()).lastTestOk).toBe(null); // never tested
    await m.service.testPlatform('admin1');
    let s: any = await m.service.getPlatformSettings();
    expect(s.lastTestOk).toBe(true);
    expect(JSON.stringify(s).includes(SANDBOX_TOKEN)).toBe(false);          // the token is never returned
    expect('lastTestTokenFp' in s).toBe(false);                             // neither is the fingerprint
    expect(String(m.platformModel.rows[0].lastTestTokenFp).length).toBe(12); // only 12 hex characters are stored
    process.env.FBR_DI_TOKEN_SANDBOX = 'another-sandbox-token-ccccccccccccc';
    s = await m.service.getPlatformSettings();
    expect(s.lastTestOk).toBe(false);
    expect(String(s.lastTestMessage).includes('changed')).toBe(true);
    process.env.FBR_DI_TOKEN_SANDBOX = SANDBOX_TOKEN;                       // back to the tested token
    expect((await m.service.getPlatformSettings()).lastTestOk).toBe(true);
  });

  it('a platform sandbox test that FBR refused is not a pass', async () => {
    const m = make(); await enablePlatform(m);
    m.setNext(() => bad({ errors: [{ code: '0401', message: 'not authorized for this NTN' }] }));
    const out: any = await m.service.testPlatform('admin1');
    expect(out.ok).toBe(false);
    expect((await m.service.getPlatformSettings()).lastTestOk).toBe(false);
  });
});

describe('FbrDiService — a store reports its own sales', () => {
  async function setupStore(m: ReturnType<typeof make>) {
    await m.service.setStoreToken('st1', 'sl1', 'sandbox', 'store-sandbox-token-cccccccccccccccc');
    await m.service.updateStoreSettings('st1', 'sl1', { enabled: true, province: 'PUNJAB', hsCode: '0101.2100' });
    m.storeSettings.rows[0].enabledSince = new Date(Date.now() - DAY); // so older orders are in range
  }
  const order = (over: any = {}) => ({
    _id: 'o1', orderNumber: 'ORD-1', currency: 'PKR', createdAt: new Date(Date.now() - 30 * MIN), isDelete: false,
    shippingAddress: { recipientName: 'Bilal', addressLine1: 'Street 1', addressLine2: null, city: 'Lahore', state: 'PUNJAB' },
    sellerOrders: [{ storeId: 'st1', sellerId: 'sl1', status: 'processing', refundedTotal: 0,
      items: [{ name: 'Shirt', variantId: 'v1', quantity: 2, totalPrice: 2000, taxUSD: 360, includedTaxUSD: 0, status: 'active' }] }],
    ...over,
  });

  it('keeps the token encrypted and never shows it back', async () => {
    const m = make();
    const view: any = await m.service.setStoreToken('st1', 'sl1', 'sandbox', 'store-sandbox-token-cccccccccccccccc');
    expect(view.tokenSandbox.set).toBe(true);
    expect(view.tokenSandbox.hint.endsWith('cccc')).toBe(true);
    expect(JSON.stringify(view).includes('store-sandbox-token')).toBe(false);
    const raw = m.storeSettings.rows[0];
    expect(String(raw.tokenSandboxEnc).includes('store-sandbox-token')).toBe(false);
    expect(String(raw.tokenSandboxEnc).length > 20).toBe(true);
  });

  it('refuses to switch on for a store without NTN / address / token / province', async () => {
    const m = make();
    let msg = ''; try { await m.service.updateStoreSettings('st1', 'sl1', { enabled: true }); } catch (e: any) { msg = e.message; }
    expect(msg.includes('token')).toBe(true);
    await m.service.setStoreToken('st1', 'sl1', 'sandbox', 'store-sandbox-token-cccccccccccccccc');
    msg = ''; try { await m.service.updateStoreSettings('st1', 'sl1', { enabled: true }); } catch (e: any) { msg = e.message; }
    expect(msg.includes('province')).toBe(true);
    m.repos.storeModel.rows[0].taxId = null;
    msg = ''; try { await m.service.updateStoreSettings('st1', 'sl1', { enabled: true, province: 'PUNJAB' }); } catch (e: any) { msg = e.message; }
    expect(msg.includes('NTN')).toBe(true);
  });

  it('a seller cannot configure another seller\'s store', async () => {
    const m = make();
    let denied = false; try { await m.service.setStoreToken('st1', 'someone-else', 'sandbox', 'store-sandbox-token-cccccccccccccccc'); } catch { denied = true; }
    expect(denied).toBe(true);
  });

  it('production is HARD-LOCKED for stores: mode, a production token, and a record carrying production are all refused', async () => {
    const m = make();
    expect((await thrown(m.service.setStoreToken('st1', 'sl1', 'production', 'prod-token-dddddddddddddddddddddd'))).includes('not accepted')).toBe(true);
    expect(m.storeSettings.rows.length).toBe(0);
    await m.service.setStoreToken('st1', 'sl1', 'sandbox', 'store-sandbox-token-cccccccccccccccc');
    expect((await thrown(m.service.updateStoreSettings('st1', 'sl1', { mode: 'production' }))).includes('locked')).toBe(true);
    expect((await thrown(m.service.updateStoreSettings('st1', 'sl1', { enabled: true, mode: 'production', province: 'PUNJAB' }))).includes('locked')).toBe(true);
    expect(m.storeSettings.rows[0].mode === 'production').toBe(false);
    expect((await m.service.getStoreSettings('st1', 'sl1')).productionLocked).toBe(true);
    // a store record that says production is never posted
    await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.service.syncStores();
    m.invoices.rows[0].mode = 'production';
    await m.service.processDue();
    expect(m.calls.length).toBe(0);
    expect(m.invoices.rows[0].status).toBe('pending');
    expect(String(m.invoices.rows[0].note).includes('locked')).toBe(true);
  });

  it('saving or deleting a store token clears its sandbox test result', async () => {
    const m = make();
    await m.service.setStoreToken('st1', 'sl1', 'sandbox', 'store-sandbox-token-cccccccccccccccc');
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { lastTestAt: new Date(), lastTestOk: true, lastTestMessage: 'FBR sandbox accepted the sample invoice.' } });
    expect((await m.service.getStoreSettings('st1', 'sl1')).lastTestOk).toBe(true);
    await m.service.setStoreToken('st1', 'sl1', 'sandbox', 'a-different-sandbox-token-eeeeeeeeee');
    let v: any = await m.service.getStoreSettings('st1', 'sl1');
    expect(v.lastTestOk).toBe(null);
    expect(v.lastTestAt).toBe(null);
    await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { lastTestAt: new Date(), lastTestOk: true } });
    await m.service.deleteStoreToken('st1', 'sl1', 'sandbox');
    v = await m.service.getStoreSettings('st1', 'sl1');
    expect(v.lastTestOk).toBe(null);
    expect(v.tokenSandbox.set).toBe(false);
  });

  // CHANGED ON PURPOSE (Phase 0): a USD order used to be 'skipped'; it is now HELD (never skipped, never sent).
  it('queues rupee orders that are still live (after 15 minutes), HOLDS a non-rupee order, skips a cancelled one', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.repos.orderModel.create(order({ _id: 'o2', orderNumber: 'ORD-2', currency: 'USD' }));
    await m.repos.orderModel.create(order({ _id: 'o3', orderNumber: 'ORD-3', sellerOrders: [{ ...order().sellerOrders[0], status: 'cancelled' }] }));
    await m.repos.orderModel.create(order({ _id: 'o4', orderNumber: 'ORD-4', createdAt: new Date(Date.now() - 2 * MIN) }));
    expect(await m.service.syncStores()).toBe(3);
    const st: any = {}; m.invoices.rows.forEach((r: any) => (st[r.sourceId] = r.status));
    expect(st.o1).toBe('pending'); expect(st.o2).toBe('held_rule'); expect(st.o3).toBe('skipped');
    expect(st.o4).toBe(undefined);
    await m.service.processDue();
    expect(m.calls.length).toBe(1); // only the rupee order
  });

  it('files an order with the store\'s own identity and an unregistered consumer', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.service.syncStores(); await m.service.processDue();
    const sent = m.calls[0];
    expect(sent.token).toBe('store-sandbox-token-cccccccccccccccc');
    expect(sent.input.sellerNTNCNIC).toBe('7654321');
    expect(sent.input.sellerBusinessName).toBe('Ali Store');
    expect(sent.input.sellerProvince).toBe('PUNJAB');
    expect(sent.input.buyerRegistrationType).toBe('Unregistered');
    expect(sent.input.buyerBusinessName).toBe('Bilal');
    expect(sent.input.buyerAddress).toBe('Street 1, Lahore');
    expect(sent.input.items[0].hsCode).toBe('6109.1000');          // the variant's own HS code
    expect(sent.input.items[0].quantity).toBe(2);
    expect(sent.input.items[0].valueSalesExcludingST).toBe(2000);
    expect(sent.input.items[0].salesTaxApplicable).toBe(360);
    expect(sent.input.items[0].rate).toBe('18%');
    expect(m.invoices.rows[0].status).toBe('submitted');
    expect(m.invoices.rows[0].storeId).toBe('st1');
  });

  it('dates an order invoice with the Pakistani date of the order (20:00 UTC on the 10th is already the 11th in Karachi)', async () => {
    const m = make(); await setupStore(m);
    m.storeSettings.rows[0].enabledSince = new Date('2026-01-01T00:00:00Z');
    await m.repos.orderModel.create(order({ createdAt: new Date(Date.now() - 20 * MIN) }));
    await m.service.syncStores(); await m.service.processDue();
    expect(m.calls[0].input.invoiceDate).toBe(pktDate(new Date(Date.now() - 20 * MIN)));
  });

  it('uses the store default HS code when the variant has none, and asks for one when neither exists', async () => {
    const m = make(); await setupStore(m);
    m.repos.productVariantModel.rows[0].hsCode = null;
    await m.repos.orderModel.create(order());
    await m.service.syncStores(); await m.service.processDue();
    expect(m.calls[0].input.items[0].hsCode).toBe('0101.2100');
    // now neither
    const m2 = make(); await setupStore(m2);
    m2.repos.productVariantModel.rows[0].hsCode = null; m2.storeSettings.rows[0].hsCode = '';
    await m2.repos.orderModel.create(order());
    await m2.service.syncStores(); await m2.service.processDue();
    expect(m2.invoices.rows[0].status).toBe('needs_info');
    expect(m2.invoices.rows[0].errors[0].message.includes('HS code')).toBe(true);
  });

  it('takes tax that is already inside the price out of the net, and discounts out of the sales value', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order({ sellerOrders: [{ storeId: 'st1', sellerId: 'sl1', status: 'processing', items: [
      { name: 'Inclusive', variantId: 'v1', quantity: 1, totalPrice: 1180, taxUSD: 0, includedTaxUSD: 180, status: 'active' },
      { name: 'Discounted', variantId: 'v1', quantity: 1, totalPrice: 1100, couponDiscountUSD: 100, taxUSD: 180, includedTaxUSD: 0, status: 'active' },
    ] }] }));
    await m.service.syncStores(); await m.service.processDue();
    const [a, b] = m.calls[0].input.items;
    expect(a.valueSalesExcludingST).toBe(1000); expect(a.salesTaxApplicable).toBe(180); expect(a.rate).toBe('18%'); expect(a.totalValues).toBe(1180);
    expect(b.valueSalesExcludingST).toBe(1000); expect(b.salesTaxApplicable).toBe(180); expect(b.rate).toBe('18%');
  });

  it('leaves cancelled lines out of the invoice', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order({ sellerOrders: [{ storeId: 'st1', sellerId: 'sl1', status: 'partially_cancelled', items: [
      { name: 'Kept', variantId: 'v1', quantity: 1, totalPrice: 1000, taxUSD: 180, status: 'active' },
      { name: 'Gone', variantId: 'v1', quantity: 1, totalPrice: 500, taxUSD: 90, status: 'cancelled' },
    ] }] }));
    await m.service.syncStores(); await m.service.processDue();
    expect(m.calls[0].input.items.length).toBe(1);
    expect(m.calls[0].input.items[0].productDescription).toBe('Kept');
  });

  it('flags a later cancel of a reported order for a human, with the 72-hour / 180-day explanation', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.service.syncStores(); await m.service.processDue();
    m.repos.orderModel.rows[0].sellerOrders[0].status = 'refunded';
    expect(await m.service.syncStores()).toBe(1);
    const adj = m.invoices.rows.find((r: any) => r.kind === 'adjustment');
    expect(adj.status).toBe('needs_review');
    expect(adj.note.includes('72 hours')).toBe(true);
    expect(adj.note.includes('180 days')).toBe(true);
    expect(m.calls.length).toBe(1);
  });

  it('lists only the store\'s own invoices and refuses a retry on someone else\'s record', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.service.syncStores(); await m.service.processDue();
    await m.invoices.create({ issuer: 'store', source: 'order', sourceId: 'zz', storeId: 'other', kind: 'sale', status: 'failed', mode: 'sandbox' });
    const list: any = await m.service.list({ issuer: 'store', storeId: 'st1' });
    expect(list.total).toBe(1);
    let denied = false; try { await m.service.retry(m.invoices.rows[1]._id, { issuer: 'store', storeId: 'st1' }); } catch { denied = true; }
    expect(denied).toBe(true);
  });

  it('exposes the FBR number of an order for printing, and nothing for an order that was not filed', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.service.syncStores(); await m.service.processDue();
    const rec: any = await m.service.orderInvoice('st1', 'o1');
    expect(rec.fbrInvoiceNumber).toBe(NUMBER);
    expect(await m.service.orderInvoice('st1', 'nope')).toBe(null);
    expect(await m.service.orderInvoice('other', 'o1')).toBe(null);
  });

  // ── wholesale (B2B) buyers: use only what the order and the company say, never guess ──
  const b2bOrder = (over: any = {}) => order({ b2b: { companyId: 'c1', companyName: 'Acme Traders' }, ...over });

  it('B2B with a valid buyer NTN => Registered + that NTN (8-digit NTN loses its check digit), named and addressed from the order', async () => {
    const m = make(); await setupStore(m);
    m.b2b.rows.push({ _id: 'c1', storeId: 'st1', name: 'Acme Traders', taxId: '1234567-8' });
    await m.repos.orderModel.create(b2bOrder());
    await m.service.syncStores(); await m.service.processDue();
    const i = m.calls[0].input;
    expect(i.buyerRegistrationType).toBe('Registered');
    expect(i.buyerNTNCNIC).toBe('1234567');
    expect(i.buyerBusinessName).toBe('Acme Traders');
    expect(i.buyerProvince).toBe('PUNJAB');
    expect(i.buyerAddress).toBe('Street 1, Lahore');
    expect(m.invoices.rows[0].status).toBe('submitted');
  });

  it('B2B without a buyer NTN => Unregistered (still named after the company)', async () => {
    const m = make(); await setupStore(m);
    m.b2b.rows.push({ _id: 'c1', storeId: 'st1', name: 'Acme Traders', taxId: null });
    await m.repos.orderModel.create(b2bOrder());
    await m.service.syncStores(); await m.service.processDue();
    expect(m.calls[0].input.buyerRegistrationType).toBe('Unregistered');
    expect(!!m.calls[0].input.buyerNTNCNIC).toBe(false);
    expect(m.calls[0].input.buyerBusinessName).toBe('Acme Traders');
  });

  it('B2B with a malformed buyer tax ID => needs_info with a clear message (not guessed, not sent)', async () => {
    const m = make(); await setupStore(m);
    m.b2b.rows.push({ _id: 'c1', storeId: 'st1', name: 'Acme Traders', taxId: 'ABC-123' });
    await m.repos.orderModel.create(b2bOrder());
    await m.service.syncStores(); await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('needs_info');
    expect(m.invoices.rows[0].errors.some((e: any) => e.message.includes('not a valid NTN/CNIC'))).toBe(true);
    expect(m.calls.length).toBe(0);
  });

  it('B2B order with no delivery address/province => needs_info; the store\'s own address is NOT used as the buyer\'s', async () => {
    const m = make(); await setupStore(m);
    m.b2b.rows.push({ _id: 'c1', storeId: 'st1', name: 'Acme Traders', taxId: '1234567' });
    await m.repos.orderModel.create(b2bOrder({ shippingAddress: null }));
    await m.service.syncStores(); await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('needs_info');
    expect(m.invoices.rows[0].errors.some((e: any) => e.message.includes('no delivery address'))).toBe(true);
    expect(m.calls.length).toBe(0);
  });

  it('B2B company that belongs to ANOTHER store is not used (tenant isolation) => needs_info', async () => {
    const m = make(); await setupStore(m);
    m.b2b.rows.push({ _id: 'c1', storeId: 'someone-elses-store', name: 'Foreign Co', taxId: '7654322' });
    await m.repos.orderModel.create(b2bOrder());
    await m.service.syncStores(); await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('needs_info');
    expect(m.invoices.rows[0].errors.some((e: any) => e.message.includes('could not be found'))).toBe(true);
    expect(m.calls.length).toBe(0);
  });

  // ── seller notifications (in-app + email), once per record ──
  it('FBR_INVOICE_PROBLEM is an in-app + email seller notification in the finance category', () => {
    expect(SELLER_EMAIL_TYPES.has(NOTIFICATION_TYPES.FBR_INVOICE_PROBLEM)).toBe(true);
    expect(NOTIFICATION_CATEGORY[NOTIFICATION_TYPES.FBR_INVOICE_PROBLEM]).toBe('finance');
  });

  it('the seller is told ONCE when FBR rejects a store invoice, never again for the same record', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    m.setNext(() => bad({}));
    await m.service.syncStores(); await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('rejected');
    expect(m.notes.length).toBe(1);
    expect(m.notes[0].type).toBe(NOTIFICATION_TYPES.FBR_INVOICE_PROBLEM);
    expect(m.notes[0].recipientId).toBe('sl1');
    expect(m.notes[0].recipientRole).toBe('seller');
    expect(m.notes[0].storeId).toBe('st1');
    expect(JSON.stringify(m.notes[0]).includes('store-sandbox-token')).toBe(false);
    expect(m.alerts.length).toBe(0); // the admin is not bothered by a store's own invoice
    // fixed, rejected again, still only one message
    await m.service.retry(m.invoices.rows[0]._id, { issuer: 'store', storeId: 'st1' });
    expect(m.notes.length).toBe(1);
  });

  it.each([
    ['token error', () => bad({ authError: true, httpStatus: 401, errors: [{ code: '401', message: 'unauthorized' }] })],
    ['unknown outcome (timeout)', timeout],
    ['unknown outcome (5xx)', http503],
  ])('the seller is told once about: %s', async (_name, outcome) => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    m.setNext(outcome as any);
    await m.service.syncStores(); await m.service.processDue();
    expect(m.notes.length).toBe(1);
    makeDue(m.invoices.rows[0]); await m.service.processDue();
    expect(m.notes.length).toBe(1);
  });

  it('the seller is told once when the retries run out (request never reached FBR, 10 times)', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    m.setNext(dns);
    await m.service.syncStores(); await m.service.processDue();
    for (let i = 1; i < FBR_MAX_ATTEMPTS; i++) { makeDue(m.invoices.rows[0]); await m.service.processDue(); }
    expect(m.invoices.rows[0].attempts).toBe(FBR_MAX_ATTEMPTS);
    expect(m.notes.length).toBe(1);
  });

  it('a crashed store invoice that the sweep finds also tells the seller once', async () => {
    const m = make(); await setupStore(m);
    await m.repos.orderModel.create(order());
    await m.service.syncStores();
    const svc: any = m.service; const realFinish = svc.finish.bind(svc);
    svc.finish = async () => { throw new Error('process died'); };
    try { await svc.attempt(m.invoices.rows[0]._id); } catch { /* the "process" died */ }
    svc.finish = realFinish;
    m.invoices.rows[0].inFlightAt = new Date(Date.now() - 30 * MIN);
    await m.service.processDue();
    expect(m.invoices.rows[0].status).toBe('unknown_outcome');
    expect(m.notes.length).toBe(1);
    expect(m.calls.length).toBe(1);
  });
});

describe('FbrDiService — resolving an unknown outcome (once per invoice, audit-logged)', () => {
  async function unknownPlatform() {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    m.setNext(timeout);
    await m.service.syncPlatform(); await m.service.processDue();
    return { m, id: m.invoices.rows[0]._id as string };
  }
  const admin = { id: 'admin-7', role: 'admin' as const };

  it('"filed": the number is checked, saved, the record becomes submitted, and the audit log says who and what', async () => {
    const { m, id } = await unknownPlatform();
    expect((await thrown(m.service.resolve(id, { issuer: 'platform' }, { action: 'filed', fbrInvoiceNumber: 'not-a-number' }, admin))).includes('exactly as the FBR portal shows it')).toBe(true);
    expect((await thrown(m.service.resolve(id, { issuer: 'platform' }, { action: 'filed' }, admin))).length > 0).toBe(true);
    expect(m.invoices.rows[0].resolvedAt).toBe(null); // a refused attempt does not use up the one resolve
    const out: any = await m.service.resolve(id, { issuer: 'platform' }, { action: 'filed', fbrInvoiceNumber: ' 7000007DI1747119701593 ', fbrDated: '2026-11-11 10:05:00' }, admin);
    expect(out.status).toBe('submitted');
    expect(out.fbrInvoiceNumber).toBe('7000007DI1747119701593');
    expect(out.qrText).toBe('7000007DI1747119701593');
    expect(out.fbrDated).toBe('2026-11-11 10:05:00');
    expect(out.resolution).toBe('filed');
    expect(out.resolvedBy).toBe('admin-7');
    expect(out.errors.length).toBe(0);
    const log = m.logs.find((l: any) => l.action === 'fbr_invoice_resolved_filed');
    expect(log.actorId).toBe('admin-7');
    expect(log.actorRole).toBe('admin');
    expect(log.targetId).toBe(id);
    expect(m.calls.length).toBe(1); // resolving "filed" sends nothing
  });

  it('"filed" cannot be done twice', async () => {
    const { m, id } = await unknownPlatform();
    await m.service.resolve(id, { issuer: 'platform' }, { action: 'filed', fbrInvoiceNumber: '7000007DI1747119701593' }, admin);
    const again = await thrown(m.service.resolve(id, { issuer: 'platform' }, { action: 'filed', fbrInvoiceNumber: '7000007DI1747119701999' }, admin));
    expect(again.length > 0).toBe(true);
    expect(m.invoices.rows[0].fbrInvoiceNumber).toBe('7000007DI1747119701593');
  });

  it('"resend": sends exactly once more, audit-logged, and a second resolve is refused', async () => {
    const { m, id } = await unknownPlatform();
    m.setNext(() => OK);
    const out: any = await m.service.resolve(id, { issuer: 'platform' }, { action: 'resend' }, admin);
    expect(out.status).toBe('submitted');
    expect(m.calls.length).toBe(2);
    expect(m.logs.some((l: any) => l.action === 'fbr_invoice_resolved_resend' && l.actorId === 'admin-7')).toBe(true);
    expect((await thrown(m.service.resolve(id, { issuer: 'platform' }, { action: 'resend' }, admin))).length > 0).toBe(true);
    expect(m.calls.length).toBe(2);
  });

  it('"resend" that comes back unknown AGAIN cannot be resolved a second time (once per record)', async () => {
    const { m, id } = await unknownPlatform();
    m.setNext(timeout);
    await m.service.resolve(id, { issuer: 'platform' }, { action: 'resend' }, admin);
    expect(m.invoices.rows[0].status).toBe('unknown_outcome');
    expect(m.calls.length).toBe(2);
    const msg = await thrown(m.service.resolve(id, { issuer: 'platform' }, { action: 'filed', fbrInvoiceNumber: '7000007DI1747119701593' }, admin));
    expect(msg.includes('already resolved once')).toBe(true);
    expect(m.calls.length).toBe(2);
  });

  it('only an unknown_outcome record can be resolved', async () => {
    const m = make(); await enablePlatform(m);
    await m.repos.platformPlanInvoiceModel.create(planInvoice());
    await m.service.syncPlatform(); await m.service.processDue(); // submitted
    const msg = await thrown(m.service.resolve(m.invoices.rows[0]._id, { issuer: 'platform' }, { action: 'resend' }, admin));
    expect(msg.includes('outcome is unknown')).toBe(true);
    expect(m.calls.length).toBe(1);
  });

  it('platform and store scopes are separate: a store cannot resolve a platform record, nor another store\'s record', async () => {
    const { m, id } = await unknownPlatform();
    expect((await thrown(m.service.resolve(id, { issuer: 'store', storeId: 'st1' }, { action: 'resend' }, { id: 'sl1', role: 'seller' }))).length > 0).toBe(true);
    // a store record
    const s = make(); await s.service.setStoreToken('st1', 'sl1', 'sandbox', 'store-sandbox-token-cccccccccccccccc');
    await s.service.updateStoreSettings('st1', 'sl1', { enabled: true, province: 'PUNJAB', hsCode: '0101.2100' });
    s.storeSettings.rows[0].enabledSince = new Date(Date.now() - DAY);
    await s.repos.orderModel.create({ _id: 'o1', orderNumber: 'ORD-1', currency: 'PKR', createdAt: new Date(Date.now() - 30 * MIN), isDelete: false, shippingAddress: { recipientName: 'B', addressLine1: 'S', addressLine2: null, city: 'L', state: 'PUNJAB' }, sellerOrders: [{ storeId: 'st1', sellerId: 'sl1', status: 'processing', items: [{ name: 'Shirt', variantId: 'v1', quantity: 1, totalPrice: 1000, taxUSD: 180, status: 'active' }] }] });
    s.setNext(timeout);
    await s.service.syncStores(); await s.service.processDue();
    const sid = s.invoices.rows[0]._id;
    expect(s.invoices.rows[0].status).toBe('unknown_outcome');
    expect((await thrown(s.service.resolve(sid, { issuer: 'store', storeId: 'another-store' }, { action: 'resend' }, { id: 'sl9', role: 'seller' }))).length > 0).toBe(true);
    expect((await thrown(s.service.resolve(sid, { issuer: 'platform' }, { action: 'resend' }, admin))).length > 0).toBe(true);
    s.setNext(() => OK);
    const out: any = await s.service.resolve(sid, { issuer: 'store', storeId: 'st1' }, { action: 'resend' }, { id: 'sl1', role: 'seller' });
    expect(out.status).toBe('submitted');
    expect(s.logs.some((l: any) => l.action === 'fbr_invoice_resolved_resend' && l.actorRole === 'seller')).toBe(true);
  });
});
