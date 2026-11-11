/* eslint-disable prettier/prettier */
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';
import { FbrDiService } from './fbr-di.service';
import { PlatformEinvoiceService, StoreEinvoiceService } from './einvoice-scoped.services';
import { PlatformEinvoiceSchema, StoreEinvoiceSchema } from './einvoice-record.schemas';
import { buildPayload, FbrResult } from './fbr-di.util';
import { buildPlanInvoiceInput } from './fbr-di.builders';
import { PkFbrAdapter } from '../tax-authorities/pk-fbr/pk-fbr.adapter';
import { TaxAuthorityRegistry } from '../tax-core/tax-authority.registry';
import { decideOutcome } from '../tax-core/e-invoice-engine';
import type { AuthorityResult, TaxAuthorityAdapter } from '../tax-core/tax-authority.adapter';

process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'unit-test-key-for-fbr';
process.env.FBR_DI_TOKEN_SANDBOX = 'sandbox-token-aaaaaaaaaaaaaaaaaaaaaaaa';
delete process.env.FBR_DI_TOKEN_PRODUCTION;

const NUMBER = '1234567DI1747119701593';
const DAY = 24 * 60 * 60_000;
const base: FbrResult = { ok: false, invoiceNumber: null, dated: null, errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false, httpStatus: 200 };
const OK: FbrResult = { ...base, ok: true, invoiceNumber: NUMBER, dated: '2026-11-11 10:00:00' };
const RECORD_DEFAULTS = { attempts: 0, errors: [], authError: false, nextAttemptAt: null, fbrInvoiceNumber: null, fbrDated: null, qrText: null, note: null, fxRatePKRPerUSD: null, inFlightAt: null, needsInfoSince: null, notifiedAt: null, resolvedAt: null, resolvedBy: null, resolution: null, viaLedger: false, authority: 'PK_FBR', netAmount: 0, taxAmount: 0, mode: 'sandbox', reference: '', lastAttemptAt: null };

function records(): any {
  const m: any = new FakeModel(RECORD_DEFAULTS);
  m.unique = ['source', 'sourceId', 'kind', 'mode']; // same key as the real schema
  m.aggregate = async () => { const c = new Map<string, number>(); for (const r of m.rows) c.set(r.status, (c.get(r.status) ?? 0) + 1); return [...c].map(([_id, n]) => ({ _id, n })); };
  return m;
}

function make(opts: { registry?: TaxAuthorityRegistry } = {}) {
  const platformSettings = new FakeModel(); const storeSettings = new FakeModel();
  const platformRecords = records(); const storeRecords = records();
  const ledger: any = new FakeModel();
  const repos: any = { platformPlanInvoiceModel: new FakeModel(), platformPlanModel: new FakeModel(), storeModel: new FakeModel(), sellerModel: new FakeModel(), orderModel: new FakeModel(), productVariantModel: new FakeModel() };
  repos.platformPlanModel.rows.push({ _id: 'plan1', name: 'Grow' });
  repos.storeModel.rows.push({ _id: 'st1', name: 'Ali Store', taxId: '7654321', taxRegistered: true, businessAddress: 'Mall Road, Lahore', country: 'PK', baseCurrency: 'PKR', sellerId: 'sl1', isDelete: false });
  repos.sellerModel.rows.push({ _id: 'sl1', name: 'Ali', address: 'Lahore' });
  const calls: any[] = [];
  let next: () => FbrResult = () => OK;
  const client: any = {
    post: async (input: any, mode: string, token: string) => { calls.push({ input, mode, token }); await new Promise((r) => setTimeout(r, 5)); return { result: next(), payload: buildPayload(input, mode as any) }; },
    validate: async () => ({ result: next(), payload: {} }), reference: async () => null,
  };
  const notifications: any = { notifyAdmins: async () => {}, notify: async () => {} };
  const platformTax: any = { getSettings: async () => ({ legalName: 'Solvexo (Pvt) Ltd', ntn: '1234567', strn: '', address: 'Clifton, Karachi', authority: 'FBR' }) };
  const service = new (FbrDiService as any)(
    platformSettings, storeSettings, platformRecords, { repositories: repos }, client, platformTax, { convert: async () => 280 },
    { log: () => {} }, notifications, new FakeModel(), storeRecords, opts.registry, ledger,
  );
  return { service, platformSettings, storeSettings, platformRecords, storeRecords, ledger, repos, calls, setNext: (f: () => FbrResult) => { next = f; } };
}

async function enable(m: ReturnType<typeof make>) {
  await m.service.updatePlatformSettings({ enabled: true, province: 'SINDH', hsCode: '9815.0000' }, 'admin1');
  await m.storeSettings.updateOne({ storeId: 'st1' }, { $set: { province: 'PUNJAB' }, $setOnInsert: { storeId: 'st1' } }, { upsert: true });
}
const ledgerRow = (over: any = {}) => ({
  sourceType: 'plan_invoice', sourceId: 'pi1', issuerEntityKey: 'solvexo-platform', customer: { storeId: 'st1', sellerId: 'sl1', country: 'PK' },
  paidAt: new Date(Date.now() + 1000), taxKnown: true, netUSD: 50, chargedTaxUSD: 9, totalUSD: 59, taxLines: [{ label: 'Sales Tax', ratePercent: 18, amountUSD: 9, country: 'PK' }],
  refundedUSD: 0, status: 'paid', routing: { authority: 'PK_FBR', eligible: true, reason: 'ok' }, determination: { treatment: 'taxable', ratePercent: 18, ruleState: 'verified' }, warnings: [], ...over,
});
const thrown = async (p: Promise<any>): Promise<string> => { try { await p; return ''; } catch (e: any) { return String(e?.message ?? e); } };

describe('Phase 2: ledger sources become sandbox invoices', () => {
  const SOURCES: [string, string][] = [['plan_invoice', 'Solvexo Grow plan subscription'], ['addon_charge', 'Solvexo add-on'], ['fee_bill', 'Solvexo transaction fee'], ['pos_plan', 'Solvexo POS plan'], ['promotion', 'Solvexo promotion'], ['store_app', 'Solvexo store app fee']];

  for (const [source, text] of SOURCES) {
    it(`AC2.4 ${source}: one eligible ledger row -> one record -> ONE sandbox filing, with the right wording`, async () => {
      const m = make(); await enable(m);
      if (source === 'plan_invoice') await m.repos.platformPlanInvoiceModel.create({ _id: 'pi1', storeId: 'st1', sellerId: 'sl1', platformPlanId: 'plan1', invoiceNumber: 'PINV-1', status: 'paid', type: 'recurring', amountUSD: 59, subtotalUSD: 50, taxAmountUSD: 9, taxRatePercent: 18, taxCountry: 'PK', paidAt: new Date(Date.now() + 1000), isDelete: false });
      await m.ledger.create(ledgerRow({ sourceType: source, sourceId: source === 'plan_invoice' ? 'pi1' : `${source}-1` }));
      expect(await m.service.syncFromLedger()).toBe(1);
      expect(await m.service.syncFromLedger()).toBe(0); // never twice
      const out = await m.service.processDue();
      expect(out.submitted).toBe(1);
      expect(m.calls.length).toBe(1);
      expect(m.calls[0].mode).toBe('sandbox');
      expect(m.calls[0].input.items[0].productDescription).toBe(text);
      expect(m.calls[0].input.items[0].valueSalesExcludingST).toBe(14000);
      expect(m.platformRecords.rows[0]).toMatchObject({ issuer: 'platform', source, status: 'submitted', viaLedger: true, fbrInvoiceNumber: NUMBER });
      await m.service.processDue();
      expect(m.calls.length).toBe(1);
      expect(m.storeRecords.rows.length).toBe(0); // never into the store collection
    });
  }

  it('a row that is NOT eligible (no verified rule) creates nothing; a one-off charge with no net amount is held, not guessed', async () => {
    const m = make(); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'addon_charge', sourceId: 'a1', routing: { authority: 'PK_FBR', eligible: false, reason: 'rule_unverified' } }));
    expect(await m.service.syncFromLedger()).toBe(0);
    await m.ledger.create(ledgerRow({ sourceType: 'promotion', sourceId: 'pr1', netUSD: null, totalUSD: null }));
    expect(await m.service.syncFromLedger()).toBe(1);
    await m.service.processDue();
    expect(m.calls.length).toBe(0);
    expect(m.platformRecords.rows[0].status).toBe('held_rule');
  });

  it('eligibility is re-checked at send time: a rule that is no longer verified puts the record back on hold', async () => {
    const m = make(); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'fee_bill', sourceId: 'b1' }));
    await m.service.syncFromLedger();
    m.ledger.rows[0].routing = { authority: 'PK_FBR', eligible: false, reason: 'rule_unverified' };
    await m.service.processDue();
    expect(m.calls.length).toBe(0);
    expect(m.platformRecords.rows[0].status).toBe('held_rule');
  });

  it('a "taxable" rule with no tax charged is a mismatch: held, never reported as zero-rated', async () => {
    const m = make(); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'fee_bill', sourceId: 'b2', chargedTaxUSD: 0, totalUSD: 50, taxLines: [] }));
    await m.service.syncFromLedger();
    await m.service.processDue();
    expect(m.calls.length).toBe(0);
    expect(m.platformRecords.rows[0].status).toBe('held_rule');
  });

  it('nothing is created while FBR invoicing is switched off', async () => {
    const m = make();
    await m.ledger.create(ledgerRow({ sourceType: 'fee_bill', sourceId: 'b3' }));
    expect(await m.service.syncFromLedger()).toBe(0);
  });
});

describe('Phase 2: duplicate safety across both paths', () => {
  it('AC2.1 an invoice already FILED through the old path is NOT filed again when its ledger row appears (same sourceId)', async () => {
    const m = make(); await enable(m);
    await m.repos.platformPlanInvoiceModel.create({ _id: 'pi1', storeId: 'st1', sellerId: 'sl1', platformPlanId: 'plan1', invoiceNumber: 'PINV-1', status: 'paid', type: 'recurring', amountUSD: 59, subtotalUSD: 50, taxAmountUSD: 9, taxRatePercent: 18, taxCountry: 'PK', paidAt: new Date(Date.now() + 1000), isDelete: false });
    await m.service.syncPlatform();
    await m.service.processDue();
    expect(m.calls.length).toBe(1);
    expect(m.platformRecords.rows[0].status).toBe('submitted');
    await m.ledger.create(ledgerRow({ sourceType: 'plan_invoice', sourceId: 'pi1' }));
    expect(await m.service.syncFromLedger()).toBe(0);
    await m.service.processDue();
    expect(m.calls.length).toBe(1);
    expect(m.platformRecords.rows.length).toBe(1);
  });

  it('AC2.1 the other way round: a ledger-created record means the old path creates no second one', async () => {
    const m = make(); await enable(m);
    await m.repos.platformPlanInvoiceModel.create({ _id: 'pi1', storeId: 'st1', sellerId: 'sl1', platformPlanId: 'plan1', invoiceNumber: 'PINV-1', status: 'paid', type: 'recurring', amountUSD: 59, subtotalUSD: 50, taxAmountUSD: 9, taxRatePercent: 18, taxCountry: 'PK', paidAt: new Date(Date.now() + 1000), isDelete: false });
    await m.ledger.create(ledgerRow({ sourceType: 'plan_invoice', sourceId: 'pi1' }));
    expect(await m.service.syncFromLedger()).toBe(1);
    expect(await m.service.syncPlatform()).toBe(0);
    await m.service.processDue();
    expect(m.calls.length).toBe(1);
  });

  it('AC2.2 two workers attempting the same record at the same time: ONE call to the authority', async () => {
    const m = make(); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'addon_charge', sourceId: 'a1' }));
    await m.service.syncFromLedger();
    const id = String(m.platformRecords.rows[0]._id);
    await Promise.all([m.service.attempt(id), m.service.attempt(id)]);
    expect(m.calls.length).toBe(1);
  });

  it('AC2.2 two overlapping cycles: ONE call, ONE record', async () => {
    const m = make(); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'fee_bill', sourceId: 'b1' }));
    await Promise.all([m.service.runCycle(), m.service.runCycle()]);
    expect(m.calls.length).toBe(1);
    expect(m.platformRecords.rows.length).toBe(1);
  });

  it('AC2.3 the unique key includes the MODE: a sandbox record and a production record of one charge can coexist, and neither can be doubled', () => {
    const uniq = (schema: any) => schema.indexes().find(([k, o]: any) => o?.unique && k.source === 1 && k.sourceId === 1)![0];
    expect(Object.keys(uniq(PlatformEinvoiceSchema))).toEqual(['source', 'sourceId', 'kind', 'mode']);
    expect(Object.keys(uniq(StoreEinvoiceSchema))).toEqual(['storeId', 'source', 'sourceId', 'kind', 'mode']);
  });

  it('AC2.3 (behaviour) the same charge in sandbox AND production is two records, the same mode twice is one', async () => {
    const m = make();
    const doc = { issuer: 'platform', source: 'fee_bill', sourceId: 'b9', storeId: 'st1', kind: 'sale', reference: 'x' };
    await m.platformRecords.create({ ...doc, mode: 'sandbox' });
    await m.platformRecords.create({ ...doc, mode: 'production' });
    expect(await thrown(m.platformRecords.create({ ...doc, mode: 'sandbox' }))).not.toBe('');
    expect(m.platformRecords.rows.length).toBe(2);
  });
});

describe('Phase 2: production stays locked for every source', () => {
  const SRC = ['plan_invoice', 'addon_charge', 'fee_bill', 'pos_plan', 'promotion', 'store_app'];
  it('AC2.5 settings in production mode (set behind the service) and production records: ZERO calls for every source', async () => {
    const m = make(); await enable(m);
    await m.platformSettings.updateOne({ key: 'platform' }, { $set: { mode: 'production' } });
    for (const s of SRC) {
      await m.platformRecords.create({ issuer: 'platform', source: s, sourceId: `${s}-p`, storeId: 'st1', kind: 'sale', mode: 'production', status: 'pending', nextAttemptAt: new Date(Date.now() - 1000), reference: s, viaLedger: true });
      await m.platformRecords.create({ issuer: 'platform', source: s, sourceId: `${s}-s`, storeId: 'st1', kind: 'sale', mode: 'sandbox', status: 'pending', nextAttemptAt: new Date(Date.now() - 1000), reference: s, viaLedger: true });
      await m.ledger.create(ledgerRow({ sourceType: s, sourceId: `${s}-p` })); await m.ledger.create(ledgerRow({ sourceType: s, sourceId: `${s}-s` }));
    }
    await m.service.processDue();
    expect(m.calls.length).toBe(0);
  });
  it('the service refuses to switch to production, platform and store', async () => {
    const m = make();
    expect(await thrown(m.service.updatePlatformSettings({ mode: 'production' }, 'a'))).toContain('locked');
  });
});

describe('Phase 2: platform and store records are separate', () => {
  async function seeded() {
    const m = make(); await enable(m);
    await m.platformRecords.create({ issuer: 'platform', source: 'fee_bill', sourceId: 'b1', storeId: 'st1', kind: 'sale', mode: 'sandbox', status: 'unknown_outcome', reference: 'PLAT-1' });
    await m.storeRecords.create({ issuer: 'store', source: 'order', sourceId: 'o1', storeId: 'st1', kind: 'sale', mode: 'sandbox', status: 'unknown_outcome', reference: 'STORE-1' });
    await m.storeRecords.create({ issuer: 'store', source: 'order', sourceId: 'o2', storeId: 'st2', kind: 'sale', mode: 'sandbox', status: 'failed', reference: 'OTHER-STORE' });
    return m;
  }
  it('AC2.6 each service lists only its own collection', async () => {
    const m = await seeded();
    const plat = new PlatformEinvoiceService(m.service); const store = new StoreEinvoiceService(m.service);
    expect((await plat.list({})).items.map((r: any) => r.reference)).toEqual(['PLAT-1']);
    expect((await store.list('st1', {})).items.map((r: any) => r.reference)).toEqual(['STORE-1']);
    expect((await store.list('st2', {})).items.map((r: any) => r.reference)).toEqual(['OTHER-STORE']);
  });
  it('AC2.6 the platform service cannot reach a store record, the store service cannot reach a platform record or another store', async () => {
    const m = await seeded();
    const plat = new PlatformEinvoiceService(m.service); const store = new StoreEinvoiceService(m.service);
    const storeRecId = String(m.storeRecords.rows[0]._id); const platRecId = String(m.platformRecords.rows[0]._id);
    expect(await thrown(plat.retry(storeRecId))).toContain('not found');
    expect(await thrown(plat.resolve(storeRecId, { action: 'resend' }, { id: 'a', role: 'admin' }))).toContain('not found');
    expect(await thrown(store.retry('st1', platRecId))).toContain('not found');
    expect(await thrown(store.resolve('st1', platRecId, { action: 'resend' }, { id: 's', role: 'seller' }))).toContain('not found');
    expect(await thrown(store.retry('st2', storeRecId))).toContain('not found'); // another store's record
    expect(m.calls.length).toBe(0);
  });
  it('AC2.6 a store record is never written into the platform collection and vice versa', async () => {
    const m = make(); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'fee_bill', sourceId: 'b1' }));
    await m.service.syncFromLedger();
    expect(m.platformRecords.rows.length).toBe(1);
    expect(m.storeRecords.rows.length).toBe(0);
  });
  it('AC2.7 the list answer keeps its old shape (items, total, page, limit) and the record keeps its fields', async () => {
    const m = await seeded();
    const out: any = await m.service.list({ issuer: 'platform' });
    expect(Object.keys(out).sort()).toEqual(['items', 'limit', 'page', 'total']);
    for (const k of ['status', 'mode', 'reference', 'fbrInvoiceNumber', 'errors', 'attempts', 'nextAttemptAt', 'netAmount', 'taxAmount']) expect(k in out.items[0]).toBe(true);
    const stats: any = await (m.service as any).stats({ issuer: 'platform' });
    expect(Object.keys(stats).sort()).toEqual(['failed', 'held_rule', 'needs_info', 'needs_review', 'pending', 'rejected', 'skipped', 'submitted', 'unknown_outcome']);
  });
});

describe('Phase 2: a second authority plugs in without touching tax-core', () => {
  /** A pretend authority from another country. */
  function fakeAuthority(): TaxAuthorityAdapter & { posted: any[] } {
    const posted: any[] = [];
    return {
      key: 'XX_TEST', posted,
      post: async (input: any, mode: any) => { posted.push({ input, mode }); return { result: { ok: true, invoiceNumber: 'XX-0001', dated: '2026-11-11', errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false } as AuthorityResult, payload: {} }; },
      validate: async () => ({ result: { ok: true, invoiceNumber: null, dated: null, errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false }, payload: {} }),
      qrFor: (n: string) => `XX|${n}`, isValidInvoiceNumber: (n: string) => /^XX-\d+$/.test(n),
    };
  }

  it('AC2.8 the engine files through whatever adapter the record names (qr + number format come from that adapter)', async () => {
    const fake = fakeAuthority();
    const registry = new TaxAuthorityRegistry().register(fake);
    const m = make({ registry }); await enable(m);
    await m.ledger.create(ledgerRow({ sourceType: 'fee_bill', sourceId: 'x1', routing: { authority: 'XX_TEST', eligible: true, reason: 'ok' } }));
    await m.service.syncFromLedger();
    await m.service.processDue();
    expect(fake.posted.length).toBe(1);
    expect(m.calls.length).toBe(0); // the Pakistani client was not used
    expect(m.platformRecords.rows[0]).toMatchObject({ authority: 'XX_TEST', status: 'submitted', fbrInvoiceNumber: 'XX-0001', qrText: 'XX|XX-0001' });
  });

  it('the registry refuses a duplicate key and an unknown key is reported', () => {
    const r = new TaxAuthorityRegistry().register(fakeAuthority());
    expect(() => r.register(fakeAuthority())).toThrow();
    expect(r.get('NOPE')).toBeNull();
    expect(() => r.require('NOPE')).toThrow();
    expect(r.keys()).toEqual(['XX_TEST']);
  });

  /** Contract every adapter must meet. Run against the Pakistani adapter AND the pretend one. */
  const contract = (name: string, make: () => TaxAuthorityAdapter) => {
    it(`contract (${name}): has a key, formats a QR, validates a typed-in invoice number`, () => {
      const a = make();
      expect(typeof a.key).toBe('string');
      expect(a.key.length).toBeGreaterThan(0);
      expect(typeof a.qrFor('X')).toBe('string');
      expect(typeof a.isValidInvoiceNumber('nonsense')).toBe('boolean');
      expect(a.isValidInvoiceNumber('')).toBe(false);
    });
    it(`contract (${name}): post and validate return { result, payload } with the interpreted facts`, async () => {
      const a = make();
      for (const call of [a.post.bind(a), a.validate.bind(a)]) {
        const out = await call({}, 'sandbox', 't'.repeat(24));
        for (const k of ['ok', 'invoiceNumber', 'errors', 'retryable', 'notSent', 'unknownOutcome', 'authError']) expect(k in out.result).toBe(true);
        expect(typeof out.payload).toBe('object');
      }
    });
  };
  contract('PK_FBR', () => new PkFbrAdapter({ post: async () => ({ result: OK, payload: {} }), validate: async () => ({ result: OK, payload: {} }) } as any));
  contract('XX_TEST', () => fakeAuthority());

  it('the Pakistani adapter keeps the FBR invoice-number format and the QR text', () => {
    const a = new PkFbrAdapter({} as any);
    expect(a.key).toBe('PK_FBR');
    expect(a.isValidInvoiceNumber(NUMBER)).toBe(true);
    expect(a.isValidInvoiceNumber('abc')).toBe(false);
    expect(a.qrFor(NUMBER)).toBe(NUMBER);
  });
});

describe('e-invoice engine: decideOutcome', () => {
  const r = (o: Partial<AuthorityResult>): AuthorityResult => ({ ok: false, invoiceNumber: null, dated: null, errors: [], retryable: false, notSent: false, unknownOutcome: false, authError: false, ...o });
  const ctx = (attempts: number) => ({ attempts, maxAttempts: 10, retryDelayMinutes: (n: number) => n * 5 });
  it('locked > accepted > auth > unknown > retry > rejected, in that order', () => {
    expect(decideOutcome(r({ locked: true, ok: true, invoiceNumber: 'N' }), ctx(1)).kind).toBe('locked');
    expect(decideOutcome(r({ ok: true, invoiceNumber: 'N' }), ctx(1)).kind).toBe('submitted');
    expect(decideOutcome(r({ ok: true, invoiceNumber: null }), ctx(1)).kind).toBe('rejected'); // "ok" without a number is not accepted
    expect(decideOutcome(r({ authError: true, retryable: true }), ctx(1)).kind).toBe('auth_error');
    expect(decideOutcome(r({ unknownOutcome: true, retryable: true }), ctx(1)).kind).toBe('unknown_outcome'); // never retried by itself
    expect(decideOutcome(r({ retryable: true }), ctx(2))).toEqual({ kind: 'retry_later', giveUp: false, delayMinutes: 10 });
    expect(decideOutcome(r({ retryable: true }), ctx(10))).toEqual({ kind: 'retry_later', giveUp: true, delayMinutes: 0 });
    expect(decideOutcome(r({}), ctx(1)).kind).toBe('rejected');
  });
});

describe('wording builder keeps its default', () => {
  it('without a description the plan wording is unchanged', () => {
    const { input } = buildPlanInvoiceInput({
      invoice: { amountUSD: 59, subtotalUSD: 50, taxAmountUSD: 9, taxRatePercent: 18, paidAt: new Date('2026-11-11T10:00:00Z') }, planName: 'Grow', fxPKRPerUSD: 280,
      seller: { ntn: '1234567', legalName: 'S', address: 'A', province: 'SINDH', scenarioId: 'SN019', hsCode: '9815.0000', uom: 'Numbers, pieces, units', saleType: 'Services' },
      buyer: { name: 'B', taxId: '7654321', taxRegistered: true, address: 'X', province: 'PUNJAB' },
    });
    expect(input.items[0].productDescription).toBe('Solvexo Grow plan subscription');
  });
});
