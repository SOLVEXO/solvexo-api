/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosReportsService } from './pos-reports.service';
import { PosApiKeysService } from './pos-api-keys.service';
import { PosExtController } from './pos-ext.controller';
import { moneyContractViolations } from './testing/money-contract';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G5.7 on a real replica-set MongoDB: the accounting export (store time zone, minor + formatted, cost obeys hide-costs, audited) and store API keys. */
jest.setTimeout(300_000);
let h: MongoHarness; let r: any; let svc: PosService; let reports: PosReportsService; let keys: PosApiKeysService; let ext: PosExtController;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const add = (k: string, n: string, sc: any) => { if (!h.repos[k]) h.repos[k] = h.conn.models[n] ?? h.conn.model(n, sc); };
  add('posExpenseModel', schema.PosExpense.name, schema.PosExpenseSchema);
  add('posExpenseEventModel', schema.PosExpenseEvent.name, schema.PosExpenseEventSchema);
  add('supplierModel', schema.Supplier.name, schema.SupplierSchema);
  add('supplierLedgerEntryModel', schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema);
  Object.assign(h.repos, { posApiKeyModel: h.conn.model(schema.PosApiKey.name, schema.PosApiKeySchema), posApiKeyWindowModel: h.conn.model(schema.PosApiKeyWindow.name, schema.PosApiKeyWindowSchema) });
  r = h.repos; await r.posApiKeyModel.init(); await r.posApiKeyWindowModel.init();
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, svc);
  reports = new PosReportsService(dbs, svc, auth);
  keys = new PosApiKeysService(dbs, svc, auth);
  ext = new PosExtController(dbs, reports);
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed) => jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
async function world() {
  const s = await seedStore(h, { stock: 20, price: 10, baseCurrency: 'PKR' });
  await r.storeModel.updateOne({ _id: s.storeId }, { $set: { timezone: 'Asia/Karachi' } });
  await r.productVariantModel.updateOne({ _id: s.variantId }, { $set: { costPrice: 6, costPriceMinor: 600 } });
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
  const sale: any = (await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 2 }], paymentMethod: 'cash' } as any, tok(s))).data;
  await svc.refundSale(s.sellerId, String(sale._id), { items: [{ saleItemId: String(sale.items[0]._id), qty: 1 }] } as any, tok(s));
  return { s, sale };
}
const today = () => new Date().toISOString().slice(0, 10);
const parse = (csv: string) => csv.trim().split('\n').map((l) => l.split(','));

describe('G5.7 · accounting export', () => {
  it('owner: invoice + credit note rows in the store time zone, minor + currency + exponent + formatted, with cost; audited', async () => {
    const { s, sale } = await world();
    const out = await reports.accountingCsv(owner(s), s.storeId, { from: today(), to: today() }, {});
    const [head, ...rows] = parse(out.csv);
    expect(head).toEqual(['date_local', 'time_zone', 'type', 'number', 'reference', 'party', 'payment_methods', 'currency', 'currency_exponent', 'net_minor', 'tax_minor', 'total_minor', 'cost_minor', 'net', 'tax', 'total', 'cost']);
    const inv = rows.find((x) => x[2] === 'invoice')!; const cn = rows.find((x) => x[2] === 'credit note')!;
    expect(inv.slice(1, 4)).toEqual(['Asia/Karachi', 'invoice', sale.invoice.number]);
    expect([inv[7], inv[8], inv[11], inv[15]]).toEqual(['PKR', '2', String(sale.totalMinor), (sale.totalMinor / 100).toFixed(2)]);
    expect(inv[12]).toBe('1200'); // 2 × 600
    expect(Number(cn[11])).toBeLessThan(0);
    expect(out.costsIncluded).toBe(true);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'accounting_export' })).toBe(1);
  });

  it('a manager with hide-costs on gets no cost columns; a cashier is refused', async () => {
    const { s } = await world();
    await r.posSettingsModel.updateOne({ storeId: s.storeId }, { $set: { 'securityPrefs.hideCostsFromManagers': true } }, { upsert: true });
    const out = await reports.accountingCsv(device(s), s.storeId, { from: today(), to: today() }, { employee: tok(s) });
    expect(parse(out.csv)[0]).not.toContain('cost_minor');
    expect(out.costsIncluded).toBe(false);
    const cashier = jwt.sign({ employeeId: s.cashierId, storeId: s.storeId, role: 'cashier', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
    expect(await code(reports.accountingCsv(device(s), s.storeId, { from: today(), to: today() }, { employee: cashier }))).toBe('POS_ACTION_FORBIDDEN');
  });

  it('a value that starts like a formula is neutralised', async () => {
    const { s } = await world();
    await r.posExpenseModel.create({ storeId: s.storeId, number: 'EXP-000001', seq: 1, category: 'other', amountMinor: 500, currency: 'PKR', currencyExponent: 2, payee: '=HYPERLINK("x")', method: 'bank', occurredAt: new Date() });
    const out = await reports.accountingCsv(owner(s), s.storeId, { from: today(), to: today() }, {});
    expect(out.csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('G5.7 · store API keys', () => {
  it('owner only; shown once, stored hashed; scoped read access; revoke stops it; every use audited', async () => {
    const { s } = await world();
    expect(await code(keys.create(device(s), s.storeId, { name: 'Books', scopes: ['sales:read'] }, { employee: tok(s) }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(keys.create(owner(s), s.storeId, { name: 'Books', scopes: ['sales:write'] }, {}))).toBe('SCOPES_INVALID');
    expect(await code(keys.create(owner(s), s.storeId, { name: 'Books', scopes: ['sales:read'], expiresInDays: 400 }, {}))).toBe('EXPIRY_INVALID');
    const made: any = (await keys.create(owner(s), s.storeId, { name: 'Books', scopes: ['sales:read', 'accounting:read'], expiresInDays: 30 }, {})).data;
    expect(made.key).toMatch(/^sxk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const row: any = await r.posApiKeyModel.findOne({ prefix: made.apiKey.prefix }).lean();
    expect(JSON.stringify(row)).not.toContain(made.key.split('_').pop()); // only the hash is kept
    const listed: any = (await keys.list(owner(s), s.storeId, {})).data.keys[0];
    expect(listed).not.toHaveProperty('key');
    expect(listed.status).toBe('active');

    const p = await keys.authenticate(made.key, 'sales:read', 'GET /api/pos/ext/v1/sales');
    const sales: any = (await ext.sales({ apiKey: p }, {})).data;
    expect(sales.sales.length).toBe(1);
    expect(sales.sales[0]).toMatchObject({ currency: 'PKR', currencyExponent: 2 });
    expect(JSON.stringify(sales)).not.toMatch(/cost/i);
    expect(moneyContractViolations({ data: sales })).toEqual([]);
    expect(await code(keys.authenticate(made.key, 'inventory:read', 'GET /api/pos/ext/v1/inventory'))).toBe('API_KEY_SCOPE');
    expect(await code(keys.authenticate(made.key.slice(0, -1) + (made.key.endsWith('A') ? 'B' : 'A'), 'sales:read', 'x'))).toBe('API_KEY_INVALID');
    await keys.audit(p, 'GET /api/pos/ext/v1/sales', 200);

    await keys.revoke(owner(s), s.storeId, made.apiKey.id, {});
    expect(await code(keys.authenticate(made.key, 'sales:read', 'GET /api/pos/ext/v1/sales'))).toBe('API_KEY_REVOKED');
    const acts = (await r.posAuditLogModel.find({ storeId: s.storeId, targetType: 'api_key' }).lean()).map((a: any) => a.action);
    expect(acts).toEqual(expect.arrayContaining(['api_key_created', 'api_key_used', 'api_key_revoked']));
    expect(acts.filter((a: string) => a === 'api_key_used').length).toBeGreaterThanOrEqual(3); // scope refusal + accepted use + revoked attempt
  });

  it('expired keys are refused; the per-minute limit applies per key; the CSV through a key never has cost', async () => {
    const { s } = await world();
    process.env.API_KEY_RATE_PER_MIN = '3';
    const made: any = (await keys.create(owner(s), s.storeId, { name: 'BI', scopes: ['accounting:read', 'inventory:read'] }, {})).data;
    for (let i = 0; i < 3; i++) await keys.authenticate(made.key, 'inventory:read', 'GET inv');
    expect(await code(keys.authenticate(made.key, 'inventory:read', 'GET inv'))).toBe('API_KEY_RATE_LIMITED');
    delete process.env.API_KEY_RATE_PER_MIN;
    const csv = await reports.accountingCsvForKey(s.storeId, { from: today(), to: today() }, { keyId: made.apiKey.id, prefix: made.apiKey.prefix });
    expect(csv.csv.split('\n')[0]).not.toContain('cost');
    const inv: any = (await ext.inventory({ apiKey: { storeId: s.storeId } }, {})).data;
    expect(inv.products[0].variants[0]).toMatchObject({ stock: expect.any(Number), priceMinor: 1000 });
    expect(JSON.stringify(inv)).not.toMatch(/cost/i);
    expect(moneyContractViolations({ data: inv })).toEqual([]);
    await r.posApiKeyModel.updateOne({ _id: made.apiKey.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await code(keys.authenticate(made.key, 'accounting:read', 'x', new Date(Date.now() + 120_000)))).toBe('API_KEY_EXPIRED');
  });
});
