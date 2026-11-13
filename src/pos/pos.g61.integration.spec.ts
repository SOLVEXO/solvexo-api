/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { JobLease, JobLeaseSchema } from '@/common/job-lease/job-lease.schema';
import { JobLeaseService } from '@/common/job-lease/job-lease.service';
import { PosService } from './pos.service';
import { PosReceiptService } from './pos-receipt.service';
import { FISCAL_MAX_ATTEMPTS, PosFiscalService } from './pos-fiscal.service';
import { FiscalDocumentInput, FiscalProvider, FiscalResult, MockFiscalProvider } from './connectors/fiscal';
import { moneyContractViolations } from './testing/money-contract';
import { connectorUi } from './pos-connectors.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G6.1 — the fiscal contract (every status, display lines, message, retry) and the per-document / sweep leases, on a real replica-set MongoDB. */
jest.setTimeout(300_000);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
let h: MongoHarness; let r: any; let leaseModel: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, { posFiscalRecordModel: h.conn.model(schema.PosFiscalRecord.name, schema.PosFiscalRecordSchema) });
  r = h.repos; await r.posFiscalRecordModel.init();
  leaseModel = h.conn.model(JobLease.name, JobLeaseSchema); await leaseModel.init();
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed) => jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
async function fresh(fiscalOn = true) {
  const s = await seedStore(h, { stock: 20, price: 10 });
  const svc = new PosService({ repositories: r } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
  if (fiscalOn) await r.posSettingsModel.updateOne({ storeId: s.storeId }, { $set: { 'connectorPrefs.fiscal': true } }, { upsert: true });
  return { s, svc, sid };
}
type X = Awaited<ReturnType<typeof fresh>>;
const sell = (x: X) => x.svc.createSale(x.s.sellerId, { storeId: x.s.storeId, sessionId: x.sid, registerId: x.s.registerId, employeeId: x.s.cashierId, items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }], paymentMethod: 'cash' } as any, tok(x.s)) as Promise<any>;
const fiscal = (p: FiscalProvider, leases?: JobLeaseService) => new PosFiscalService({ repositories: r } as any, p, leases);
const docs = async (x: X, f: PosFiscalService, saleId: string) => (await new PosReceiptService({ repositories: r } as any, x.svc, f).documentsOf(x.s.sellerId, saleId)).data as any;
const CONTRACT_KEYS = ['status', 'externalInvoiceNumber', 'qrPayload', 'displayLines', 'message', 'willRetry', 'logoUrl', 'testMode', 'contractVersion', 'attempts', 'lastError'];

/** A provider that counts calls and can be slowed down (to make two runners overlap). */
class CountingProvider implements FiscalProvider {
  readonly key = 'counting'; readonly testMode = true; calls = 0; readonly seen: string[] = [];
  constructor(private readonly delayMs = 0, private readonly result: Partial<FiscalResult> = {}) {}
  async fiscalise(d: FiscalDocumentInput): Promise<FiscalResult> {
    this.calls++; this.seen.push(`${d.storeId}:${d.documentNumber}`); await sleep(this.delayMs);
    return { status: 'confirmed', fiscalInvoiceNumber: `CNT-${d.documentNumber}`, qrPayload: `q:${d.documentNumber}`, displayLines: [{ label: 'Auth no.', value: `CNT-${d.documentNumber}` }], ...this.result };
  }
}

describe('G6.1 · fiscal contract: every status', () => {
  it('confirmed: number, QR, the provider\'s display lines as given, willRetry false; same block on the sale response, the read and the documents', async () => {
    const x = await fresh(); const f = fiscal(new MockFiscalProvider({}));
    const sale = await sell(x); await f.afterSaleResponse(x.s.storeId, sale);
    const n = `MOCK-FBR-I-${sale.data.invoice.number}`;
    expect(Object.keys(sale.data.invoice.fiscal)).toEqual(expect.arrayContaining(CONTRACT_KEYS));
    expect(sale.data.invoice.fiscal).toMatchObject({ status: 'confirmed', externalInvoiceNumber: n, displayLines: [{ label: 'Mock fiscal no.', value: n }, { label: 'Mode', value: 'TEST — not filed' }], message: null, willRetry: false, contractVersion: 1, testMode: true });
    const read: any = await x.svc.getSaleById(x.s.sellerId, String(sale.data._id)); await f.overlaySale(read.data);
    expect(read.data.invoice.fiscal.displayLines).toHaveLength(2);
    expect((await docs(x, f, String(sale.data._id))).invoice.fiscal.displayLines[0].value).toBe(n);
    expect(moneyContractViolations(sale)).toEqual([]);
  });

  it('pending: provider down → pending, willRetry, no message; the sweep confirms it later', async () => {
    const x = await fresh(); const down = fiscal(new MockFiscalProvider({ MOCK_FISCAL_MODE: 'down' }));
    const sale = await sell(x); await down.afterSaleResponse(x.s.storeId, sale);
    expect(sale.data.invoice.fiscal).toMatchObject({ status: 'pending', willRetry: true, message: null, displayLines: [] });
    await fiscal(new MockFiscalProvider({})).sweep();
    expect((await docs(x, down, String(sale.data._id))).invoice.fiscal).toMatchObject({ status: 'confirmed', attempts: 2 });
  });

  it('failed: not resent by the sweep; message for the cashier / owner; listed as an issue; the owner retry sends it again (audited, who asked)', async () => {
    const x = await fresh(); const failing = fiscal(new MockFiscalProvider({ MOCK_FISCAL_MODE: 'fail' }));
    const sale = await sell(x); const id = String(sale.data._id);
    await failing.afterSaleResponse(x.s.storeId, sale);
    expect(sale.data.invoice.fiscal).toMatchObject({ status: 'failed', willRetry: false });
    expect(sale.data.invoice.fiscal.message).toMatch(/not sent again/);
    expect(sale.data.status).toBe('completed'); // the sale stands
    const ok = fiscal(new MockFiscalProvider({}));
    await ok.sweep();
    expect(await r.posFiscalRecordModel.countDocuments({ documentId: id })).toBe(1); // NOT resent automatically
    const issues = await ok.issues(x.s.storeId);
    expect(issues.find((i: any) => i.documentId === id)).toMatchObject({ status: 'failed', retryable: true, documentType: 'invoice' });
    const after = await ok.retry(x.s.storeId, 'invoice', id, 'owner-1');
    expect(after).toMatchObject({ status: 'confirmed', attempts: 2 });
    expect(await r.posAuditLogModel.countDocuments({ storeId: x.s.storeId, action: 'fiscal_confirmed', targetId: id, employeeId: 'owner-1', 'metadata.manualRetry': true })).toBe(1);
    expect((await ok.issues(x.s.storeId)).find((i: any) => i.documentId === id)).toBeUndefined();
  });

  it('rejected: final; message shown; listed; a retry is refused with FISCAL_NOT_RETRYABLE', async () => {
    const x = await fresh(); const rej = fiscal(new MockFiscalProvider({ MOCK_FISCAL_MODE: 'reject' }));
    const sale = await sell(x); const id = String(sale.data._id);
    await rej.afterSaleResponse(x.s.storeId, sale);
    expect(sale.data.invoice.fiscal).toMatchObject({ status: 'rejected', willRetry: false });
    expect(sale.data.invoice.fiscal.message).toMatch(/refused/);
    expect((await rej.issues(x.s.storeId)).find((i: any) => i.documentId === id)).toMatchObject({ status: 'rejected', retryable: false });
    await expect(rej.retry(x.s.storeId, 'invoice', id, 'owner-1')).rejects.toMatchObject({ response: { code: 'FISCAL_NOT_RETRYABLE' } });
  });

  it('pending past the attempt limit reads failed (retries stopped) with a message', () => {
    const v = PosFiscalService.view(null, { status: 'pending', fiscalInvoiceNumber: null, qrPayload: null, attempts: FISCAL_MAX_ATTEMPTS, lastError: null }, true);
    expect(v).toMatchObject({ status: 'failed', willRetry: false });
    expect(v.message).toMatch(/retries stopped/i);
  });

  it('not fiscalised, store switch off: the live placeholder is unchanged (status not_enabled) plus the additive contract fields', async () => {
    const x = await fresh(false); const f = fiscal(new MockFiscalProvider({}));
    const sale = await sell(x); await f.afterSaleResponse(x.s.storeId, sale);
    const d = await docs(x, f, String(sale.data._id));
    expect(d.invoice.fiscal).toMatchObject({ status: 'not_enabled', externalInvoiceNumber: null, displayLines: [], willRetry: false, contractVersion: 1 });
  });

  it('a refund response carries its credit note\'s fiscal block (contract shape)', async () => {
    const x = await fresh(); const f = fiscal(new MockFiscalProvider({}));
    const sale = await sell(x);
    const ref: any = await x.svc.refundSale(x.s.sellerId, String(sale.data._id), {}, tok(x.s));
    const b = await f.fiscaliseCreditNote(x.s.storeId, ref.data.creditNote.id);
    const v = PosFiscalService.view(ref.data.creditNote.fiscal, b ?? undefined, true);
    expect(v).toMatchObject({ status: 'confirmed', externalInvoiceNumber: `MOCK-FBR-C-${ref.data.creditNote.number}`, contractVersion: 1 });
  });

  it('the public receipt page prints the display lines as given, and nothing for pending', () => {
    const esc = (s: string) => s.replace(/</g, '&lt;');
    expect(PosReceiptService.fiscalHtml({ status: 'confirmed', displayLines: [{ label: 'Auth', value: 'X<1' }] }, esc)).toContain('Auth X&lt;1');
    expect(PosReceiptService.fiscalHtml({ status: 'confirmed', externalInvoiceNumber: 'N-1', displayLines: [] }, esc)).toContain('N-1');
    expect(PosReceiptService.fiscalHtml({ status: 'pending', displayLines: [] }, esc)).toBe('');
  });
});

describe('G6.1 · one provider call per document across instances (MongoDB lease)', () => {
  it('two concurrent runners on the same document → the provider is called ONCE, one record, and the result equals a single run', async () => {
    const x = await fresh(); const sale = await sell(x); const id = String(sale.data._id);
    const p = new CountingProvider(400);
    const a = fiscal(p, new JobLeaseService(leaseModel)); const b = fiscal(p, new JobLeaseService(leaseModel)); // two "instances"
    await Promise.all([a.fiscaliseSale(x.s.storeId, id), b.fiscaliseSale(x.s.storeId, id)]);
    expect(p.calls).toBe(1);
    expect(await r.posFiscalRecordModel.countDocuments({ documentId: id })).toBe(1);
    const single = await fresh(); const s2 = await sell(single); const p2 = new CountingProvider(0);
    await fiscal(p2).fiscaliseSale(single.s.storeId, String(s2.data._id));
    const strip = (v: any) => ({ ...v, externalInvoiceNumber: v.externalInvoiceNumber?.replace(/\d+$/, '#'), qrPayload: null, displayLines: v.displayLines.map((l: any) => ({ ...l, value: l.value.replace(/\d+$/, '#') })) });
    expect(strip((await docs(x, a, id)).invoice.fiscal)).toEqual(strip((await docs(single, a, String(s2.data._id))).invoice.fiscal));
  });

  it('two sweeps at once → each pending document is sent once', async () => {
    const x = await fresh(); const ids: string[] = [];
    const numbers: string[] = [];
    for (let i = 0; i < 3; i++) { const s = await sell(x); ids.push(String(s.data._id)); numbers.push(`${x.s.storeId}:${s.data.invoice.number}`); }
    const p = new CountingProvider(150);
    const a = fiscal(p, new JobLeaseService(leaseModel)); const b = fiscal(p, new JobLeaseService(leaseModel));
    await Promise.all([a.sweepTick(), b.sweepTick()]);
    for (const id of ids) expect(await r.posFiscalRecordModel.countDocuments({ documentId: id })).toBe(1);
    for (const n of numbers) expect(p.seen.filter((v) => v === n)).toHaveLength(1); // each document sent exactly once (other stores' documents may be swept too)
  });

  it('an EXPIRED document lease (holder died) is taken over and the document is fiscalised', async () => {
    const x = await fresh(); const sale = await sell(x); const id = String(sale.data._id);
    const dead = new JobLeaseService(leaseModel);
    await dead.tryAcquire(`pos:fiscal:invoice:${id}`, 300); // holder dies without releasing
    const p = new CountingProvider(0); const f = fiscal(p, new JobLeaseService(leaseModel));
    expect(await f.fiscaliseSale(x.s.storeId, id)).toBeNull(); // still held: nothing sent, nothing recorded yet
    expect(p.calls).toBe(0);
    await sleep(500);
    expect(await f.fiscaliseSale(x.s.storeId, id)).toMatchObject({ status: 'confirmed', attempts: 1 });
    expect(p.calls).toBe(1);
  });
});

describe('G6.1 · provider-dependent wording and rules come from the server (connectors.ui)', () => {
  it('Raast: "simulate paid" only for the mock outside production; reason codes become words; poll interval and instructions are sent', () => {
    const dev = connectorUi({ raastProvider: 'mock', raastReason: null, cardGateway: null }, { NODE_ENV: 'development' } as any);
    expect(dev.raast).toMatchObject({ simulateAvailable: true, pollAfterMs: 2000, reasonText: null });
    expect(dev.raast.customerInstructions).toMatch(/scan/);
    expect(connectorUi({ raastProvider: 'mock', raastReason: null, cardGateway: null }, { NODE_ENV: 'production' } as any).raast.simulateAvailable).toBe(false);
    expect(connectorUi({ raastProvider: 'payfast', raastReason: null, cardGateway: null }, { NODE_ENV: 'development' } as any).raast.simulateAvailable).toBe(false);
    expect(connectorUi({ raastProvider: 'x', raastReason: 'kyb_pending', cardGateway: null }).raast.reasonText).toMatch(/Verify your business/);
    expect(connectorUi({ raastProvider: 'x', raastReason: 'no_sub_merchant', cardGateway: null }).raast.reasonText).toMatch(/being set up/);
    expect(connectorUi({ raastProvider: 'x', raastReason: 'something_new', cardGateway: null }).raast.reasonText).toBeNull();
  });

  it('card on a bank terminal: the fields (key, label, required, pattern, length, keyboard) are the server\'s; card gateway text', () => {
    const ui = connectorUi({ raastProvider: null, raastReason: null, cardGateway: { key: 'mock', testMode: true } });
    expect(ui.cardExternalTerminal.fields.map((f) => [f.key, f.required])).toEqual([['approvalCode', true], ['last4', false], ['terminalLabel', false]]);
    expect(new RegExp(ui.cardExternalTerminal.fields[1].pattern as string).test('1234')).toBe(true);
    expect(new RegExp(ui.cardExternalTerminal.fields[1].pattern as string).test('12a4')).toBe(false);
    expect(ui.cardGateway.statusText).toMatch(/Not available yet/);
    expect(connectorUi({ raastProvider: null, raastReason: null, cardGateway: { key: 'realgw', testMode: false } }).cardGateway.statusText).toBeNull();
    expect(ui.receipts).toMatchObject({ whatsapp: { mode: 'link' }, minPhoneDigits: 10 });
  });
});
