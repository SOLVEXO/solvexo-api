/* eslint-disable prettier/prettier */
import * as fs from 'fs';
import * as path from 'path';
import { PlatformLedgerService } from './platform-ledger.service';

// ---- tiny in-memory stand-ins for the Mongoose models (just what the ledger uses) ----
const get = (o: any, p: string) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function matches(doc: any, f: any): boolean {
  return Object.entries(f ?? {}).every(([k, cond]: [string, any]) => {
    if (k === '$or') return (cond as any[]).some((c) => matches(doc, c));
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('$exists' in cond) return (v !== undefined) === cond.$exists;
      if ('$ne' in cond) return v !== cond.$ne;
      if ('$gt' in cond) return String(v) > String(cond.$gt);
      if ('$in' in cond) return (cond.$in as any[]).map(String).includes(String(v));
    }
    if (k.endsWith('.0') && cond && typeof cond === 'object') return true;
    return v === cond || (v instanceof Date && cond instanceof Date && v.getTime() === cond.getTime());
  });
}
class Source {
  constructor(public docs: any[]) {}
  find(f: any) {
    let rows = this.docs.filter((d) => matches(d, f));
    const chain: any = {
      sort: () => { rows = [...rows].sort((a, b) => String(a._id).localeCompare(String(b._id))); return chain; },
      limit: (n: number) => { rows = rows.slice(0, n); return chain; },
      select: () => chain,
      lean: () => Promise.resolve(JSON.parse(JSON.stringify(rows), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v) : v))),
    };
    return chain;
  }
}
class FakeLedger {
  rows: any[] = [];
  writes = 0;
  async countDocuments() { return this.rows.length; }
  find(f: any) { return new Source(this.rows).find(f); }
  async updateOne(key: any, update: any, opts: any = {}) {
    this.writes++;
    const i = this.rows.findIndex((r) => r.sourceType === key.sourceType && r.sourceId === key.sourceId);
    if (i >= 0) {
      const before = JSON.stringify(this.rows[i]);
      this.rows[i] = { ...this.rows[i], ...update.$set };
      return { upsertedCount: 0, modifiedCount: JSON.stringify(this.rows[i]) === before ? 0 : 1 };
    }
    if (!opts.upsert) return { upsertedCount: 0, modifiedCount: 0 };
    await Promise.resolve(); // let a parallel run get in between "not found" and "insert": the real race
    if (this.rows.some((r) => r.sourceType === key.sourceType && r.sourceId === key.sourceId)) { const e: any = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
    this.rows.push({ ...key, ...update.$setOnInsert, ...update.$set });
    return { upsertedCount: 1, modifiedCount: 0 };
  }
}

const id = (n: number) => String(n).padStart(24, '0');
const PAID = new Date('2026-11-01T10:00:00Z');
const entity = { entityKey: 'solvexo-platform', country: 'PK', registrations: [{ country: 'PK', type: 'NTN', number: '1234567', authority: 'PK_FBR' }] };

function build(over: { rules?: any[] } = {}) {
  const planInvoices = new Source([
    { _id: id(1), storeId: id(100), sellerId: 'u1', status: 'paid', paidAt: PAID, amountUSD: 29.58, subtotalUSD: 29, taxAmountUSD: 0.58, taxRatePercent: 2, taxLabel: 'Sales Tax', taxCountry: 'PK', isDelete: false },
    { _id: id(2), storeId: id(101), sellerId: 'u2', status: 'paid', paidAt: PAID, amountUSD: 29, subtotalUSD: null, taxAmountUSD: 0, isDelete: false },
    { _id: id(3), storeId: id(100), status: 'failed', paidAt: null, amountUSD: 29, isDelete: false },
  ]);
  const addons = new Source([{ _id: id(10), storeId: id(100), sellerId: 'u1', charges: [{ amountUSD: 10, taxUSD: 0.2, chargedAt: PAID }, { amountUSD: 10, chargedAt: PAID }] }]);
  const feeBills = new Source([{ _id: id(20), storeId: id(100), sellerId: 'u1', status: 'paid', paidAt: PAID, amountUSD: 5, taxAmountUSD: 0.1, isDelete: false }, { _id: id(21), storeId: id(100), status: 'paid', paidAt: PAID, amountUSD: 5, isDelete: false }]);
  const taxRecords = new Source([{ _id: id(30), source: 'promotion', refId: 'pi_1', storeId: id(100), taxAmountUSD: 1.5, collectedAt: PAID }]);
  const stores = new Source([{ _id: id(100), country: 'PK' }, { _id: id(101), country: 'GB' }]);
  const ledger = new FakeLedger();
  const entities: any = { load: async () => ({ entity, rules: over.rules ?? [], settings: {} }) };
  const svc = new PlatformLedgerService({ repositories: { storeModel: stores } } as any, entities, ledger as any, planInvoices as any, addons as any, feeBills as any, taxRecords as any);
  const sources = { planInvoices, addons, feeBills, taxRecords, stores };
  return { svc, ledger, sources, snapshot: () => JSON.stringify(sources) };
}

describe('PlatformLedgerService (read-only shadow)', () => {
  const OLD = process.env.PLATFORM_LEDGER_ENABLED;
  afterEach(() => { if (OLD === undefined) delete process.env.PLATFORM_LEDGER_ENABLED; else process.env.PLATFORM_LEDGER_ENABLED = OLD; });

  it('AC1.5 flag off (or anything but "true"): a real run writes no row at all', async () => {
    for (const v of [undefined, 'false', '1', 'yes', '']) {
      if (v === undefined) delete process.env.PLATFORM_LEDGER_ENABLED; else process.env.PLATFORM_LEDGER_ENABLED = v;
      const { svc, ledger } = build();
      const s = await svc.sync({ dryRun: false });
      expect(s.skippedReason).toBe('disabled');
      expect(ledger.rows.length).toBe(0);
      expect(ledger.writes).toBe(0);
    }
  });

  it('AC1.4 dry run writes nothing but reports what it would create (works even with the flag off)', async () => {
    delete process.env.PLATFORM_LEDGER_ENABLED;
    const { svc, ledger } = build();
    const s = await svc.sync({ dryRun: true });
    expect(ledger.rows.length).toBe(0);
    expect(ledger.writes).toBe(0);
    expect(s.dryRun).toBe(true);
    expect(s.created).toBe(7); // 2 plan invoices (failed one skipped) + 2 add-on charges + 2 fee bills + 1 promotion... = 7
    expect(s.examined).toBe(7);
  });

  it('creates one row per paid source (golden values) and tax-unknown rows carry null, not 0', async () => {
    process.env.PLATFORM_LEDGER_ENABLED = 'true';
    const { svc, ledger } = build();
    const s = await svc.sync({ dryRun: false });
    expect(s.created).toBe(7);
    expect(ledger.rows.length).toBe(7);
    const by = (t: string, i: string) => ledger.rows.find((r) => r.sourceType === t && r.sourceId === i);
    expect(by('plan_invoice', id(1))).toMatchObject({ taxKnown: true, netUSD: 29, chargedTaxUSD: 0.58, totalUSD: 29.58, customer: { storeId: id(100), country: 'PK' } });
    const unknownPlan = by('plan_invoice', id(2));
    expect(unknownPlan).toMatchObject({ taxKnown: false, chargedTaxUSD: null, taxLines: null, customer: { country: 'GB' } });
    expect(by('addon_charge', `${id(10)}:0`)).toMatchObject({ taxKnown: true, chargedTaxUSD: 0.2 });
    expect(by('addon_charge', `${id(10)}:1`)).toMatchObject({ taxKnown: false, chargedTaxUSD: null });
    expect(by('fee_bill', id(20))).toMatchObject({ taxKnown: true, chargedTaxUSD: 0.1 });
    expect(by('fee_bill', id(21))).toMatchObject({ taxKnown: false, chargedTaxUSD: null });
    expect(by('promotion', 'pi_1')).toMatchObject({ taxKnown: true, chargedTaxUSD: 1.5, netUSD: null });
    expect(ledger.rows.every((r) => r.issuerEntityKey === 'solvexo-platform')).toBe(true);
    expect(ledger.rows.some((r) => r.taxKnown === false && (r.chargedTaxUSD === 0))).toBe(false);
  });

  it('AC1.3 running again creates 0 new rows', async () => {
    process.env.PLATFORM_LEDGER_ENABLED = 'true';
    const { svc, ledger } = build();
    await svc.sync({ dryRun: false });
    const s2 = await svc.sync({ dryRun: false });
    expect(s2.created).toBe(0);
    expect(ledger.rows.length).toBe(7);
    expect(s2.unchanged).toBe(7);
  });

  it('AC1.3 two runs at the same time still leave ONE row per source (loser gets E11000 and just updates)', async () => {
    process.env.PLATFORM_LEDGER_ENABLED = 'true';
    const { svc, ledger } = build();
    const [a, b] = await Promise.all([svc.sync({ dryRun: false }), svc.sync({ dryRun: false })]);
    expect(ledger.rows.length).toBe(7);
    const keys = new Set(ledger.rows.map((r) => `${r.sourceType}|${r.sourceId}`));
    expect(keys.size).toBe(7);
    expect(a.created + b.created).toBe(7);
    expect(a.racedDuplicates + b.racedDuplicates).toBeGreaterThan(0);
  });

  it('AC1.2 the source collections are byte-identical before and after a sync', async () => {
    process.env.PLATFORM_LEDGER_ENABLED = 'true';
    const { svc, snapshot } = build();
    const before = snapshot();
    await svc.sync({ dryRun: false });
    await svc.sync({ dryRun: false });
    expect(snapshot()).toBe(before);
  });

  it('a refund later on the source updates the row (no second row)', async () => {
    process.env.PLATFORM_LEDGER_ENABLED = 'true';
    const { svc, ledger, sources } = build();
    await svc.sync({ dryRun: false });
    const inv = sources.planInvoices.docs[0];
    inv.status = 'refunded'; inv.refundedAmountUSD = 29.58;
    const s = await svc.sync({ dryRun: false });
    expect(s.created).toBe(0);
    expect(s.updated).toBe(1);
    expect(ledger.rows.find((r) => r.sourceId === id(1))).toMatchObject({ status: 'refunded', refundedUSD: 29.58 });
  });

  it('routing: nothing is eligible without a verified rule; a UK store row says rule_unverified', async () => {
    process.env.PLATFORM_LEDGER_ENABLED = 'true';
    const { svc, ledger } = build({ rules: [{ country: 'GB', supplyType: 'saas_subscription', treatment: 'taxable', ratePercent: 20, state: 'legacy_confirmed' }] });
    await svc.sync({ dryRun: false });
    expect(ledger.rows.every((r) => r.routing.eligible === false)).toBe(true);
    const uk = ledger.rows.find((r) => r.sourceType === 'plan_invoice' && r.sourceId === id(2));
    expect(uk.routing.reason).toBe('tax_unknown');
    const withVerified = build({ rules: [{ country: 'PK', supplyType: 'saas_subscription', treatment: 'taxable', ratePercent: 2, state: 'verified' }] });
    await withVerified.svc.sync({ dryRun: false });
    const ok = withVerified.ledger.rows.find((r) => r.sourceType === 'plan_invoice' && r.sourceId === id(1));
    expect(ok.routing).toMatchObject({ eligible: true, reason: 'ok' });
  });
});

describe('Phase 1 boundaries (static)', () => {
  const dir = __dirname;
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  const ledgerFiles = ['platform-ledger.service.ts', 'platform-ledger.util.ts', 'platform-ledger.controller.ts', 'platform-tax-determination.service.ts', 'platform-entity.service.ts'];

  it('AC1.10 the ledger has no connection to the FBR module or any HTTP client (it cannot file anything)', () => {
    for (const f of ledgerFiles) {
      const src = read(f);
      expect(/from\s+['"][^'"]*fbr[^'"]*['"]/i.test(src)).toBe(false);
      expect(/from\s+['"](axios|node-fetch|undici)['"]/.test(src)).toBe(false);
      expect(/\bfetch\(/.test(src)).toBe(false);
    }
  });
  it('the ledger code never writes to a billing collection: only platform_* models have write calls', () => {
    const src = read('platform-ledger.service.ts');
    const writes = src.match(/this\.(\w+)\.(updateOne|updateMany|insertMany|create|deleteOne|deleteMany|findOneAndUpdate|bulkWrite)\(/g) ?? ([] as string[]);
    expect(writes.every((w) => w.startsWith('this.ledger.'))).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
  });
  it('the controller is read-only (GET routes only)', () => {
    const src = read('platform-ledger.controller.ts');
    expect(/@(Post|Put|Patch|Delete)\(/.test(src)).toBe(false);
    expect((src.match(/@Get\(/g) ?? []).length).toBe(2);
  });
  it('the existing PlatformTaxService file is untouched by the ledger (no reference to it)', () => {
    for (const f of ledgerFiles) expect(/platform-tax\.service/.test(read(f))).toBe(false);
  });
});
