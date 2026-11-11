/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosInventoryService } from './pos-inventory.service';
import { PosReportsService } from './pos-reports.service';
import { PosStoreSettingsService } from './pos-store-settings.service';
import { CostVisibilityInterceptor } from './cost-visibility.interceptor';
import { PosReprintService } from './pos-reprint.service';
import { PosReceiptService } from './pos-receipt.service';
import { PosCatalogAdminService } from './pos-catalog-admin.service';
import { Types } from 'mongoose';
import { GLOBAL_COST_KEYS, costKeysFor, carriesCost } from './cost-visibility.registry';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { StockCountSchema } from '../stock-counts/schemas/stock-count.schema';
import { InventoryService } from '../inventory/inventory.service';

/** G4.8 hardening on a real replica-set MongoDB: costs hidden from managers (one interceptor over every POS response). */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let inv: PosInventoryService; let rep: PosReportsService; let st: PosStoreSettingsService; let costs: CostVisibilityInterceptor; let reprints: PosReprintService; let receipts: PosReceiptService; let cat: PosCatalogAdminService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const c = h.conn;
  Object.assign(h.repos, {
    stockAdjustmentModel: c.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: c.model('StockLot', StockLotSchema), stockCountModel: c.model('StockCount', StockCountSchema),
    orderModel: c.model('OrderG48', new mongoose.Schema({}, { strict: false })), staffMemberModel: c.model('StaffMember', new mongoose.Schema({ name: String }, { strict: false })),
    posAuditSealModel: c.model(schema.PosAuditSeal.name, schema.PosAuditSealSchema), posReprintEventModel: c.model(schema.PosReprintEvent.name, schema.PosReprintEventSchema), posPriceBookModel: c.model(schema.PosPriceBook.name, schema.PosPriceBookSchema),
    posExpenseModel: c.model(schema.PosExpense.name, schema.PosExpenseSchema), posExpenseEventModel: c.model(schema.PosExpenseEvent.name, schema.PosExpenseEventSchema),
    supplierLedgerEntryModel: c.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
    posAttendanceEventModel: c.model(schema.PosAttendanceEvent.name, schema.PosAttendanceEventSchema), posAttendanceStateModel: c.model(schema.PosAttendanceState.name, schema.PosAttendanceStateSchema),
  });
  r = h.repos;
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, svc);
  const invSvc = new InventoryService(dbs, { isConnected: false } as any, { notify: jest.fn() } as any, c as any);
  inv = new PosInventoryService(dbs, svc, auth, invSvc, {} as any);
  rep = new PosReportsService(dbs, svc, auth);
  st = new PosStoreSettingsService(dbs, svc, auth);
  costs = new CostVisibilityInterceptor(dbs, auth);
  reprints = new PosReprintService(dbs, svc, auth);
  receipts = new PosReceiptService(dbs, svc);
  cat = new PosCatalogAdminService(dbs, svc, auth, {} as any, {} as any, {} as any);
  await r.posReprintEventModel.init();
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed, who: 'manager' | 'cashier' = 'manager') => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } }, headers: { 'x-pos-employee-token': tok(s, who) }, params: { storeId: s.storeId }, query: {} });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' }, headers: {}, params: { storeId: s.storeId }, query: {} });

async function world() {
  const s = await seedStore(h, { stock: 10, price: 5, baseCurrency: 'USD' });
  await r.productVariantModel.updateOne({ _id: s.variantId }, { $set: { costPrice: 2, costPriceMinor: 200 } });
  return s;
}
const hide = (s: Seed, on: boolean) => st.update(owner(s) as any, s.storeId, { security: { hideCostsFromManagers: on } }, {});

describe('G4.8 · hide costs from managers', () => {
  it('off (default): a manager sees cost and stock value; the owner turns it on (audited) → the manager sees none of it, with costsHidden', async () => {
    const s = await world();
    const M = { employee: tok(s, 'manager') };
    const path = `/api/pos/inventory/stock/${s.storeId}`;
    const raw = await inv.stock(device(s) as any, s.storeId, {}, M);
    expect(carriesCost(raw, costKeysFor(path))).toBe(true);
    expect(await costs.apply(device(s), path, raw)).toEqual(raw); // off: untouched

    await hide(s, true);
    const audit = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'store_settings_changed' }).lean();
    expect(audit.metadata.changed).toContain('securityPrefs.hideCostsFromManagers');

    const seen: any = await costs.apply(device(s), path, await inv.stock(device(s) as any, s.storeId, {}, M));
    expect(carriesCost(seen, costKeysFor(path))).toBe(false);
    expect(seen.data.costsHidden).toBe(true);
    expect(seen.data.items[0].stock).toBe(10); // quantities stay
    // the overview: stock value gone, counts stay
    const ov: any = await costs.apply(device(s), `/api/pos/inventory/overview/${s.storeId}`, await inv.overview(device(s) as any, s.storeId, M));
    expect(ov.data.stockValueMinor).toBeUndefined();
    expect(ov.data.costsHidden).toBe(true);
  });

  it('the owner always sees cost; a cashier never did and still does not', async () => {
    const s = await world();
    await hide(s, true);
    const path = `/api/pos/inventory/stock/${s.storeId}`;
    const asOwner: any = await costs.apply(owner(s), path, await inv.stock(owner(s) as any, s.storeId, {}, {}));
    expect(asOwner.data.costsHidden).toBeUndefined();
    expect(carriesCost(asOwner, costKeysFor(path))).toBe(true);
    const C = { employee: tok(s, 'cashier') };
    const asCashier: any = await costs.apply(device(s, 'cashier'), path, await inv.stock(device(s, 'cashier') as any, s.storeId, {}, C));
    expect(carriesCost(asCashier, costKeysFor(path))).toBe(false);
  });

  it('reports: profit loses margin / COGS / after expenses and says costsHidden; revenue stays; a report without cost still gets the flag', async () => {
    const s = await world();
    await hide(s, true);
    const M = { employee: tok(s, 'manager') };
    const day = new Date().toISOString().slice(0, 10);
    const profit: any = await costs.apply(device(s), `/api/pos/reports/profit/${s.storeId}`, await rep.profit(device(s) as any, s.storeId, { from: day, to: day }, M));
    expect(profit.data.costsHidden).toBe(true);
    expect(carriesCost(profit, GLOBAL_COST_KEYS)).toBe(false);
    expect(profit.data.totals.netSalesMinor).toBeDefined();
    expect(profit.data.totals.supplierPaymentsMinor).toBeUndefined(); // payables are hidden too
    const sales: any = await costs.apply(device(s), `/api/pos/reports/sales/${s.storeId}`, await rep.sales(device(s) as any, s.storeId, { from: day, to: day }, M));
    expect(sales.data.costsHidden).toBe(true);
    expect(sales.data.totals.netSalesMinor).toBeDefined();
  });

  it('responses with no cost fields and routes outside /api/pos are never touched (no read)', async () => {
    const s = await world();
    await hide(s, true);
    const body = { success: true, data: { storeId: s.storeId, items: [{ totalMinor: 500 }] } };
    const spy = jest.spyOn(r.posSettingsModel, 'findOne');
    expect(await costs.apply(device(s), `/api/pos/sales/${s.storeId}`, body)).toBe(body);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('G4.8 · reprints (recorded; a PIN when the store requires it)', () => {
  const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message; } };
  async function withSale(s: Seed, invoice = true) {
    const id = new Types.ObjectId();
    await r.saleModel.collection.insertOne({ _id: id, storeId: s.storeId, saleNumber: 'S-0001', status: 'completed', items: [], total: 5, ...(invoice ? { invoice: { number: 'INV-1' } } : {}), createdAt: new Date() });
    return String(id);
  }
  const C = (s: Seed) => ({ employee: tok(s, 'cashier') });

  it('off: a cashier reprints; each reprint numbered, counted on the sale and audited in the same write', async () => {
    const s = await world(); const sale = await withSale(s);
    const a: any = await reprints.reprint(device(s, 'cashier'), s.storeId, { documentType: 'sale', documentId: sale, reason: 'customer lost it' }, C(s));
    const b: any = await reprints.reprint(device(s, 'cashier'), s.storeId, { documentType: 'sale', documentId: sale }, C(s));
    expect([a.data.reprintNumber, b.data.reprintNumber]).toEqual([1, 2]);
    expect((await r.saleModel.findById(sale).lean()).reprintCount).toBe(2);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'document_reprinted', targetId: sale })).toBe(2);
    const ev = await r.posReprintEventModel.findOne({ documentId: sale, reprintNumber: 1 }).lean();
    expect([ev.reason, ev.deviceId, ev.role]).toEqual(['customer lost it', 'd1', 'cashier']);
    await expect(r.posReprintEventModel.updateOne({ _id: ev._id }, { $set: { reason: 'x' } })).rejects.toThrow(/append-only/);
  });

  it('on: a cashier needs a manager PIN (POS_APPROVAL_REQUIRED without one); a manager reprints directly', async () => {
    const s = await world(); const sale = await withSale(s);
    await st.update(owner(s) as any, s.storeId, { security: { requirePinForReprint: true } }, {});
    expect(await code(reprints.reprint(device(s, 'cashier'), s.storeId, { documentType: 'invoice', documentId: sale }, C(s)))).toBe('POS_APPROVAL_REQUIRED');
    expect(await code(reprints.reprint(device(s, 'cashier'), s.storeId, { documentType: 'invoice', documentId: sale }, { ...C(s), approver: tok(s, 'cashier') }))).toBe('POS_APPROVAL_REQUIRED');
    const ok: any = await reprints.reprint(device(s, 'cashier'), s.storeId, { documentType: 'invoice', documentId: sale }, { ...C(s), approver: tok(s, 'manager') });
    expect([ok.data.reprintNumber, ok.data.approvedBy]).toEqual([1, s.managerId]);
    const m: any = await reprints.reprint(device(s, 'manager'), s.storeId, { documentType: 'invoice', documentId: sale }, { employee: tok(s, 'manager') });
    expect(m.data.reprintNumber).toBe(2);
    // the documents read-out carries the counts
    const docs: any = await receipts.documentsOf(s.sellerId, sale);
    expect([docs.data.invoice.reprintCount, docs.data.receiptReprintCount]).toEqual([2, 0]);
  });

  it('two tills at once: distinct numbers; a sale with no invoice or another store\'s sale is refused', async () => {
    const s = await world(); const sale = await withSale(s, false);
    const both: any[] = await Promise.all([1, 2].map(() => reprints.reprint(device(s, 'manager'), s.storeId, { documentType: 'sale', documentId: sale }, { employee: tok(s, 'manager') })));
    expect(both.map((x) => x.data.reprintNumber).sort()).toEqual([1, 2]);
    expect(await code(reprints.reprint(device(s, 'manager'), s.storeId, { documentType: 'invoice', documentId: sale }, { employee: tok(s, 'manager') }))).toBe('NO_INVOICE');
    const other = await world();
    expect(await code(reprints.reprint(device(s, 'manager'), s.storeId, { documentType: 'sale', documentId: await withSale(other) }, { employee: tok(s, 'manager') }))).toBe('DOCUMENT_NOT_FOUND');
    expect(await code(reprints.reprint(device(s, 'manager'), s.storeId, { documentType: 'receipt', documentId: sale }, { employee: tok(s, 'manager') }))).toBe('DOCUMENT_TYPE_INVALID');
  });
});

describe('G4.8 · price-book validity in the store\'s time zone (the server runs in UTC)', () => {
  const M = (s: Seed) => ({ employee: tok(s, 'manager') });
  async function storeIn(tz: string) { const s = await world(); await r.storeModel.updateOne({ _id: s.storeId }, { $set: { timezone: tz } }); return s; }
  const make = async (s: Seed, body: any) => (await cat.priceBookCreate(device(s) as any, s.storeId, { name: `B ${Math.random()}`, ...body }, M(s))).data.book;

  it('Karachi (+5, no DST): store days → the store\'s midnights in UTC; the stored instants are the same', async () => {
    const b = await make(await storeIn('Asia/Karachi'), { validFrom: '2026-11-12', validTo: '2026-11-15' });
    expect([b.validFromUtc, b.validToUtc]).toEqual(['2026-11-11T19:00:00.000Z', '2026-11-15T19:00:00.000Z']);
    expect([b.validFromDay, b.validToDay, b.timeZone]).toEqual(['2026-11-12', '2026-11-15', 'Asia/Karachi']);
    expect(new Date(b.startsAt).toISOString()).toBe(b.validFromUtc);
  });

  it('a DST-free zone other than Karachi (Dubai, +4)', async () => {
    const b = await make(await storeIn('Asia/Dubai'), { validFrom: '2026-11-12', validTo: '2026-11-12' });
    expect([b.validFromUtc, b.validToUtc, b.validToDay]).toEqual(['2026-11-11T20:00:00.000Z', '2026-11-12T20:00:00.000Z', '2026-11-12']);
  });

  it('a DST zone on its switch day (New York, 8 March 2026: 23 hours long)', async () => {
    const b = await make(await storeIn('America/New_York'), { validFrom: '2026-03-08', validTo: '2026-03-08' });
    expect([b.validFromUtc, b.validToUtc]).toEqual(['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z']);
  });

  it('in force follows the store\'s day (a book from the store\'s tomorrow is not in force yet); instants still work; a bad day is refused', async () => {
    const s = await storeIn('Pacific/Kiritimati'); // UTC+14: the store's "tomorrow" starts many hours before the server's
    const today = new Date(Date.now() + 14 * 3600_000).toISOString().slice(0, 10);
    const next = new Date(Date.now() + 38 * 3600_000).toISOString().slice(0, 10);
    await make(s, { name: 'from tomorrow', validFrom: next });
    await make(s, { name: 'today only', validFrom: today, validTo: today });
    const list: any = await cat.priceBooks(device(s) as any, s.storeId, M(s));
    const by = (n: string) => list.data.books.find((x: any) => x.name === n);
    expect([by('from tomorrow').inForce, by('today only').inForce]).toEqual([false, true]);
    const inst = await make(s, { startsAt: '2026-12-01T00:00:00Z' });
    expect(inst.validFromUtc).toBe('2026-12-01T00:00:00.000Z');
    await expect(cat.priceBookCreate(device(s) as any, s.storeId, { name: 'x', validFrom: '12/01/2026' }, M(s))).rejects.toMatchObject({ response: { code: 'INVALID_DATE' } });
  });
});

