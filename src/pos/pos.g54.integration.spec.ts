/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosFiscalService } from './pos-fiscal.service';
import { MockFiscalProvider, NotConfiguredFiscalProvider, fiscalProviderFor } from './connectors/fiscal';
import { MockCardGateway, NotConfiguredCardGateway, cardGatewayFor } from './connectors/card-gateway';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G5.4 (card on an external terminal) + G5.5 (fiscal provider, mock) on a real replica-set MongoDB. */
jest.setTimeout(300_000);
let h: MongoHarness; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  Object.assign(h.repos, { posFiscalRecordModel: h.conn.model(schema.PosFiscalRecord.name, schema.PosFiscalRecordSchema) });
  r = h.repos; await r.posFiscalRecordModel.init();
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed) => jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message; } };
async function fresh() {
  const s = await seedStore(h, { stock: 20, price: 10 });
  const svc = new PosService({ repositories: r } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
  return { s, svc, sid };
}
type X = Awaited<ReturnType<typeof fresh>>;
const sell = (x: X, over: any = {}) => x.svc.createSale(x.s.sellerId, { storeId: x.s.storeId, sessionId: x.sid, registerId: x.s.registerId, employeeId: x.s.cashierId, items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }], paymentMethod: 'cash', ...over } as any, tok(x.s)) as Promise<any>;
const card = (extra: any = {}) => ({ paymentMethod: 'card', payments: [{ method: 'card', amount: 10, ...extra }] });
const flags = (x: X, f: any) => r.posSettingsModel.updateOne({ storeId: x.s.storeId }, { $set: Object.fromEntries(Object.entries(f).map(([k, v]) => [`connectorPrefs.${k}`, v])) }, { upsert: true });

describe('G5.4 · card on an external terminal', () => {
  it('switch off: a card sale needs nothing extra (unchanged behaviour)', async () => {
    const x = await fresh();
    expect((await sell(x, card())).data.payments[0].method).toBe('card');
  });

  it('switch on: approval code required live; stored with last4 + terminal; shift report has its own line; refund references the code', async () => {
    const x = await fresh(); await flags(x, { cardExternalTerminal: true });
    expect(await code(sell(x, card()))).toBe('CARD_APPROVAL_REQUIRED');
    const sale = (await sell(x, card({ approvalCode: 'A1B2C3', last4: '4242', terminalLabel: 'HBL #1' }))).data;
    expect(sale.payments[0].terminal).toMatchObject({ approvalCode: 'A1B2C3', last4: '4242', label: 'HBL #1' });
    const rep: any = (await x.svc.getSessionReport(x.s.sellerId, x.sid)).data;
    expect(rep.summary.cardExternalTerminal).toMatchObject({ count: 1, approvalCodes: ['A1B2C3'], terminals: ['HBL #1'] });
    const ref: any = await x.svc.refundSale(x.s.sellerId, String(sale._id), {}, tok(x.s));
    expect(ref.data.tenders.find((t: any) => t.method === 'card')).toMatchObject({ approvalCodeRef: 'A1B2C3', externalTerminal: true });
    const cn: any = await r.posCreditNoteModel.findOne({ saleId: String(sale._id) }).lean();
    expect(cn.tenders[0].approvalCodeRef).toBe('A1B2C3');
  });

  it('switch on, offline replay without a code: accepted (the server never blocks offline sales) and audited', async () => {
    const x = await fresh(); await flags(x, { cardExternalTerminal: true });
    await sell(x, { ...card(), offline: true, clientCreatedAt: new Date(Date.now() - 60_000).toISOString(), idempotencyKey: `pos-${Date.now()}000-0123456789abcdef01234567` });
    expect(await r.posAuditLogModel.countDocuments({ storeId: x.s.storeId, action: 'card_approval_missing_offline' })).toBe(1);
  });

  it('card gateway: mock in dev, not configured in production / for named providers', async () => {
    expect(cardGatewayFor({ NODE_ENV: 'development' } as any)).toBeInstanceOf(MockCardGateway);
    expect(cardGatewayFor({ NODE_ENV: 'production', CARD_GATEWAY_PROVIDER: 'mock' } as any)).toBeInstanceOf(NotConfiguredCardGateway);
  });
});

describe('G5.5 · fiscal (mock provider)', () => {
  const service = (env: any = {}) => new PosFiscalService({ repositories: r } as any, new MockFiscalProvider(env));

  it('switch off: nothing is sent; documents keep "not_enabled"', async () => {
    const x = await fresh(); const f = service();
    const sale = await sell(x);
    await f.afterSaleResponse(x.s.storeId, sale);
    expect(await r.posFiscalRecordModel.countDocuments({ storeId: x.s.storeId })).toBe(0);
    const docs: any = (await new PosReceiptService({ repositories: r } as any, x.svc, f).documentsOf(x.s.sellerId, String(sale.data._id))).data;
    expect(docs.invoice.fiscal.status).toBe('not_enabled');
  });

  it('switch on, online: the invoice is confirmed (fiscal number + QR) — append-only and audited; credit notes too', async () => {
    const x = await fresh(); await flags(x, { fiscal: true }); const f = service();
    const sale = await sell(x); const id = String(sale.data._id);
    await f.afterSaleResponse(x.s.storeId, sale);
    const docs: any = (await new PosReceiptService({ repositories: r } as any, x.svc, f).documentsOf(x.s.sellerId, id)).data;
    expect(docs.invoice.fiscal).toMatchObject({ status: 'confirmed', externalInvoiceNumber: `MOCK-FBR-I-${sale.data.invoice.number}`, attempts: 1, testMode: true });
    expect(docs.invoice.fiscal.qrPayload).toContain('mock-fiscal:');
    expect(docs.invoice.number).toBe(sale.data.invoice.number); // our number never changes
    expect(await r.posAuditLogModel.countDocuments({ storeId: x.s.storeId, action: 'fiscal_confirmed', targetId: id })).toBe(1);
    const row: any = await r.posFiscalRecordModel.findOne({ documentId: id }).lean();
    await expect(r.posFiscalRecordModel.updateOne({ _id: row._id }, { $set: { status: 'pending' } })).rejects.toThrow(/append-only/);
    const ref: any = await x.svc.refundSale(x.s.sellerId, id, {}, tok(x.s));
    await f.fiscaliseCreditNote(x.s.storeId, ref.data.creditNote.id);
    const after: any = (await new PosReceiptService({ repositories: r } as any, x.svc, f).documentsOf(x.s.sellerId, id)).data;
    expect(after.creditNotes[0].fiscal).toMatchObject({ status: 'confirmed', externalInvoiceNumber: `MOCK-FBR-C-${ref.data.creditNote.number}` });
    await f.fiscaliseSale(x.s.storeId, id); // already confirmed → no new attempt
    expect(await r.posFiscalRecordModel.countDocuments({ documentId: id })).toBe(1);
  });

  it('provider down / offline: "pending" until the sweep confirms it; a sale that synced without a record is picked up', async () => {
    const x = await fresh(); await flags(x, { fiscal: true });
    const down = service({ MOCK_FISCAL_DOWN: 'true' });
    const a = await sell(x); await down.afterSaleResponse(x.s.storeId, a);
    const b = await sell(x); // e.g. an offline sale that synced — no attempt yet
    const rs = new PosReceiptService({ repositories: r } as any, x.svc, down);
    expect((await rs.documentsOf(x.s.sellerId, String(a.data._id))).data.invoice.fiscal).toMatchObject({ status: 'pending', attempts: 1, externalInvoiceNumber: null });
    expect((await rs.documentsOf(x.s.sellerId, String(b.data._id))).data.invoice.fiscal).toMatchObject({ status: 'pending', attempts: 0 });
    const up = service();
    expect(await up.sweep()).toBeGreaterThanOrEqual(2);
    const rs2 = new PosReceiptService({ repositories: r } as any, x.svc, up);
    expect((await rs2.documentsOf(x.s.sellerId, String(a.data._id))).data.invoice.fiscal).toMatchObject({ status: 'confirmed', attempts: 2 });
    expect((await rs2.documentsOf(x.s.sellerId, String(b.data._id))).data.invoice.fiscal.status).toBe('confirmed');
    expect(await r.posAuditLogModel.countDocuments({ storeId: x.s.storeId, action: 'fiscal_pending' })).toBe(1);
  });

  it('real routes are typed TODOs: not configured → stays pending with the reason; production never uses the mock', async () => {
    const x = await fresh(); await flags(x, { fiscal: true });
    const f = new PosFiscalService({ repositories: r } as any, new NotConfiguredFiscalProvider('pral'));
    const sale = await sell(x); await f.afterSaleResponse(x.s.storeId, sale);
    const row: any = await r.posFiscalRecordModel.findOne({ documentId: String(sale.data._id) }).lean();
    expect([row.status, row.providerKey]).toEqual(['pending', 'pral']);
    expect(row.error).toMatch(/not configured.*FBR_INTEGRATION_NEEDS/);
    expect(fiscalProviderFor({ NODE_ENV: 'production' } as any)).toBeNull();
    expect(fiscalProviderFor({ NODE_ENV: 'production', FISCAL_PROVIDER: 'mock' } as any)).toBeInstanceOf(NotConfiguredFiscalProvider);
  });
});

describe('G5.5 · sale reads and the sale response carry the fiscal block', () => {
  it('createSale response (after fiscalising) and a later read show the confirmed number in invoice.fiscal', async () => {
    const x = await fresh(); await r.posSettingsModel.updateOne({ storeId: x.s.storeId }, { $set: { 'connectorPrefs.fiscal': true } }, { upsert: true });
    const f = new PosFiscalService({ repositories: r } as any, new MockFiscalProvider({}));
    const res: any = await sell(x);
    await f.afterSaleResponse(x.s.storeId, res);
    expect(res.data.invoice.fiscal).toMatchObject({ status: 'confirmed', externalInvoiceNumber: `MOCK-FBR-I-${res.data.invoice.number}` });
    const read: any = await x.svc.getSaleById(x.s.sellerId, String(res.data._id));
    await f.overlaySale(read.data);
    expect(read.data.invoice.fiscal.status).toBe('confirmed');
  });
});
