/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosReportsService } from './pos-reports.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/**
 * G4.0 performance budget (owner decision 1): a 90-day report on a LARGE store must answer in < 2 s on this machine, computed live (no rollups).
 * Dataset: 100,000 sales over 90 days (≈ 1,111 a day), 1–4 lines each (≈ 250,000 lines), 3,000 return credit notes, 8 cashiers, 2 registers, 400 variants.
 * Opt-in (RUN_PERF=1) because timings belong to a known machine, not to a shared CI runner:  RUN_PERF=1 npx jest src/pos/pos-reports.perf.spec.ts --maxWorkers=1
 */
const run = process.env.RUN_PERF === '1' ? describe : describe.skip;
jest.setTimeout(900_000);
let h: MongoHarness; let rep: PosReportsService; let r: any;
const SALES = 100_000; const DAYS = 90; const RETURNS = 3_000; const VARIANTS = 400; const BUDGET_MS = 2_000;

run('reports performance (live, 90 days, 100k sales / ~250k lines)', () => {
  let s: Awaited<ReturnType<typeof seedStore>>; let lines = 0;
  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret';
    h = await startMongoHarness();
    Object.assign(h.repos, {
      posExpenseModel: h.conn.model(schema.PosExpense.name, schema.PosExpenseSchema), posExpenseEventModel: h.conn.model(schema.PosExpenseEvent.name, schema.PosExpenseEventSchema),
      supplierLedgerEntryModel: h.conn.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
      posAttendanceEventModel: h.conn.model(schema.PosAttendanceEvent.name, schema.PosAttendanceEventSchema), posAttendanceStateModel: h.conn.model(schema.PosAttendanceState.name, schema.PosAttendanceStateSchema),
    });
    r = h.repos;
    const dbs: any = { repositories: r };
    const pos = new PosService(dbs, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
    rep = new PosReportsService(dbs, pos, new PosAuthorizer(dbs, pos));
    s = await seedStore(h, { stock: 1, price: 10, baseCurrency: 'PKR' });
    await r.storeModel.collection.updateOne({ _id: new Types.ObjectId(s.storeId) }, { $set: { country: 'PK' } });
    const variants = Array.from({ length: VARIANTS }, () => String(new Types.ObjectId()));
    const products = variants.map(() => String(new Types.ObjectId()));
    const cashiers = Array.from({ length: 8 }, () => String(new Types.ObjectId()));
    const now = Date.now(); const t0 = now - DAYS * 86_400_000;
    const seedStart = Date.now();
    const batch: any[] = []; const saleIds: { id: Types.ObjectId; item: any }[] = [];
    for (let i = 0; i < SALES; i++) {
      const n = 1 + (i % 4); const items: any[] = [];
      let net = 0;
      for (let k = 0; k < n; k++) {
        const v = (i * 7 + k * 13) % VARIANTS; const qty = 1 + ((i + k) % 3); const price = 100 + (v % 50) * 25;
        const lineNet = qty * price; net += lineNet;
        items.push({ _id: new Types.ObjectId(), productId: products[v], variantId: variants[v], name: `Item ${v}`, sku: `SKU-${v}`, qty, price: price / 100, lineTotal: lineNet / 100, lineTotalMinor: lineNet, netMinor: lineNet, taxMinor: Math.round(lineNet * 0.17), discountShareMinor: 0, unitCostMinor: i % 50 === 0 ? null : Math.round(price * 0.6), taxCategory: 'standard', hsCode: v % 3 ? '0901.2100' : null, refundedQty: 0 });
      }
      lines += n;
      const tax = items.reduce((t, it) => t + it.taxMinor, 0);
      const id = new Types.ObjectId();
      const method = i % 3 === 0 ? 'card' : 'cash';
      batch.push({ _id: id, storeId: s.storeId, saleNumber: `P-${i}`, sessionId: 'sess', registerId: i % 2 ? 'reg1' : 'reg2', employeeId: cashiers[i % 8], status: i % 97 === 0 ? 'voided' : 'completed', items, subtotal: net / 100, totalMinor: net + tax, taxMinor: tax, discountMinor: 0, total: (net + tax) / 100, payments: [{ method, amount: (net + tax) / 100, amountMinor: net + tax }], paymentMethod: method, createdAt: new Date(t0 + Math.floor((i / SALES) * DAYS * 86_400_000)) });
      if (saleIds.length < RETURNS && i % 33 === 5) saleIds.push({ id, item: items[0] });
      if (batch.length === 5_000) { await r.saleModel.collection.insertMany(batch.splice(0)); }
    }
    if (batch.length) await r.saleModel.collection.insertMany(batch.splice(0));
    const notes = saleIds.map((x, j) => ({ storeId: s.storeId, number: `CN-${j}`, seq: j + 1, saleId: String(x.id), kind: 'return', scope: 'partial', employeeId: cashiers[j % 8], registerId: 'reg1', currency: 'PKR', currencyExponent: 2, netMinor: x.item.netMinor / x.item.qty, taxMinor: Math.round(x.item.taxMinor / x.item.qty), totalMinor: 0, lines: [{ saleItemId: String(x.item._id), productId: x.item.productId, variantId: x.item.variantId, qty: 1, netMinor: x.item.netMinor / x.item.qty, taxMinor: Math.round(x.item.taxMinor / x.item.qty), totalMinor: 0, taxCategory: 'standard', hsCode: x.item.hsCode }], createdAt: new Date(t0 + j * 2_000_000) }));
    for (let k = 0; k < notes.length; k += 1_000) await r.posCreditNoteModel.collection.insertMany(notes.slice(k, k + 1_000));
    await Promise.all(['saleModel', 'posCreditNoteModel'].map((m) => r[m].syncIndexes()));
    // eslint-disable-next-line no-console
    console.log(`[perf] seeded ${SALES} sales / ${lines} lines / ${notes.length} returns in ${Math.round((Date.now() - seedStart) / 1000)} s`);
  });
  afterAll(async () => { await h?.stop(); });

  const M = () => ({ employee: jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' }) });
  const dev = () => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
  const q = () => { const to = new Date(); const from = new Date(Date.now() - (DAYS - 1) * 86_400_000); const k = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10); return { from: k(from), to: k(to) }; };

  for (const fn of ['sales', 'profit', 'products', 'categories', 'tax', 'payments', 'cashiers', 'hourly'] as const) {
    it(`${fn}: 90 days in < ${BUDGET_MS} ms`, async () => {
      await (rep as any)[fn](dev(), s.storeId, q(), M()); // warm the cache like a real second click
      const t = Date.now();
      const out = await (rep as any)[fn](dev(), s.storeId, q(), M());
      const ms = Date.now() - t;
      // eslint-disable-next-line no-console
      console.log(`[perf] ${fn}: ${ms} ms`);
      expect(out.success).toBe(true);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }
  it('sanity: the 90-day sales report saw the seeded data', async () => {
    const d = (await rep.sales(dev(), s.storeId, q(), M())).data;
    expect(d.totals.transactions).toBeGreaterThan(SALES * 0.9);
  });
});
