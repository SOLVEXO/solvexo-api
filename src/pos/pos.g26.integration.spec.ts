/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosCatalogService } from './pos-catalog.service';
import { UpdatePosSettingsDto } from './dto/update-pos-settings.dto';
import { AdjustCatalogStockDto, UpdateCatalogVariantDto } from './dto/catalog.dto';
import { MongoHarness, oidStr, seedStore, startMongoHarness } from './testing/mongo-harness';

/** G2.6 on a real replica-set MongoDB: the Home dashboard (numbers = the existing reports, role-based, indexed), POS catalog edits, the store tax profile. */
jest.setTimeout(240_000);
let h: MongoHarness;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });

const makeService = () => new PosService({ repositories: h.repos } as any, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tokFor = (s: Seed, employeeId: string, role: string) => jwt.sign({ employeeId, storeId: s.storeId, role, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const tok = (s: Seed, who: 'manager' | 'cashier') => tokFor(s, who === 'manager' ? s.managerId : s.cashierId, who);
async function fresh(opts: Parameters<typeof seedStore>[1] = {}) {
  const s = await seedStore(h, { stock: 100, ...opts });
  const svc = makeService();
  const sid = String(new Types.ObjectId());
  await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(), openingCash: 50, totalSales: 0, totalTransactions: 0 });
  return { s, svc, sid };
}
type X = Awaited<ReturnType<typeof fresh>>;
const dto = (x: X, over: any = {}) => ({ storeId: x.s.storeId, sessionId: x.sid, registerId: x.s.registerId, employeeId: x.s.cashierId, items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 1 }], paymentMethod: 'cash', ...over });
const sell = async (x: X, over: any = {}) => ((await x.svc.createSale(x.s.sellerId, dto(x, over) as any, tok(x.s, 'manager'))) as any).data;
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

describe('Home dashboard', () => {
  it('its numbers equal the existing daily report to the minor unit (revenue, discount, tax, refunds, tenders, top products)', async () => {
    const x = await fresh({ taxRate: 0.17 });
    await sell(x);
    await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 3 }], discountType: 'percent', discountValue: 10 });
    await sell(x, { paymentMethod: 'card' });
    await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }], payments: [{ method: 'cash', amount: 15 }, { method: 'card', amount: 8.4, reference: 'A1' }] });
    const refundMe = await sell(x, { items: [{ productId: x.s.productId, variantId: x.s.variantId, qty: 2 }] });
    await x.svc.refundSale(x.s.sellerId, String(refundMe._id), { items: [{ saleItemId: String(refundMe.items[0]._id), qty: 1 }] }, tok(x.s, 'manager'));
    const voidMe = await sell(x);
    await x.svc.voidSale(x.s.sellerId, String(voidMe._id), { reasonCode: 'cashier_error' }, tok(x.s, 'manager'));
    const dash: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, tok(x.s, 'manager'))).data;
    const daily: any = (await x.svc.getDailyReport(x.s.sellerId, x.s.storeId, {})).data;
    expect(dash.summary).toEqual(daily.summary);
    expect(dash.byPaymentMethod).toEqual(daily.byPaymentMethod);
    expect(dash.topProducts).toEqual(daily.topProducts.slice(0, 5));
    expect(dash.customItems).toEqual(daily.customItems);
    expect(dash.currency).toBe(daily.currency);
    expect(dash.summary.totalTransactions).toBeGreaterThan(0);
    expect(dash.summary.refundsCount).toBe(2);
    expect(dash.summary.avgTransactionValue).toBeGreaterThan(0);
  });

  it('a cashier sees ONLY their own open shift; a manager and the owner see the store; managers also get what needs attention', async () => {
    const x = await fresh();
    // a second cashier with their own open shift on another register
    const other = oidStr();
    await h.repos.employeeModel.collection.insertOne({ _id: new Types.ObjectId(other), storeId: x.s.storeId, name: 'Olu Other', email: 'o@x.com', role: 'cashier', isDelete: false });
    const sid2 = String(new Types.ObjectId());
    await h.repos.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid2), storeId: x.s.storeId, registerId: oidStr(), employeeId: other, status: 'open', openedAt: new Date(), openingCash: 10, totalSales: 0, totalTransactions: 0 });
    await sell(x); await sell(x); // cashier 1's shift: 2 sales
    await x.svc.createSale(x.s.sellerId, { ...dto(x, { sessionId: sid2, employeeId: other }) } as any, tokFor(x.s, other, 'cashier'));
    await h.repos.saleModel.collection.updateOne({ storeId: x.s.storeId, sessionId: x.sid }, { $set: { needsReview: true } });

    const cashier: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, tok(x.s, 'cashier'))).data;
    expect(cashier).toMatchObject({ role: 'cashier', scope: 'shift', needsAttention: null });
    expect(cashier.summary.totalTransactions).toBe(2);
    expect(cashier.shifts.map((s: any) => s.sessionId)).toEqual([x.sid]);
    expect(JSON.stringify(cashier)).not.toContain('Olu');

    const manager: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, tok(x.s, 'manager'))).data;
    expect(manager).toMatchObject({ role: 'manager', scope: 'store' });
    expect(manager.summary.totalTransactions).toBe(3);
    expect(manager.shifts).toHaveLength(2);
    expect(manager.shifts.map((s: any) => s.employeeName).sort()).toEqual(['Cal Cashier', 'Olu Other']);
    expect(manager.needsAttention).toMatchObject({ salesNeedingReview: 1, digitalPayments: 0, total: 1 });

    const owner: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, undefined)).data;
    expect(owner).toMatchObject({ role: 'owner', scope: 'store' });
    expect(owner.summary.totalTransactions).toBe(3);
  });

  it('a cashier with no open shift sees an empty dashboard (not the store)', async () => {
    const x = await fresh();
    await sell(x);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(x.sid) }, { $set: { status: 'closed' } });
    const d: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, tok(x.s, 'cashier'))).data;
    expect(d.shifts).toEqual([]);
    expect(d.summary.totalTransactions).toBe(0);
  });

  it("yesterday's sales are not in today's pulse; an empty store gives zeros", async () => {
    const x = await fresh();
    const a = await sell(x);
    await h.repos.saleModel.collection.updateOne({ _id: new Types.ObjectId(String(a._id)) }, { $set: { createdAt: new Date(Date.now() - 36 * 3_600_000) } });
    const d: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, tok(x.s, 'manager'))).data;
    expect(d.summary.totalTransactions).toBe(0);
    expect(d.summary.totalRevenue).toBe(0);
    expect(d.topProducts).toEqual([]);
  });

  it('another store\'s seller cannot read it', async () => {
    const x = await fresh();
    await expect(x.svc.getDashboard(oidStr(), x.s.storeId, undefined)).rejects.toBeDefined();
  });

  it('is efficient: the day\'s sales are read through the (storeId, createdAt) index, and 600 sales answer fast', async () => {
    const x = await fresh();
    const base: any = await sell(x);
    const docs = Array.from({ length: 600 }, (_, i) => { const { _id, ...rest } = JSON.parse(JSON.stringify(base)); return { ...rest, saleNumber: `BULK-${i}`, invoice: undefined, createdAt: new Date(), updatedAt: new Date(), items: base.items.map((it: any) => ({ ...JSON.parse(JSON.stringify(it)), _id: new Types.ObjectId() })) }; });
    await h.repos.saleModel.collection.insertMany(docs.map((d2: any) => { delete d2.invoice; return { ...d2, createdAt: new Date(), updatedAt: new Date() }; }) as any);
    const t0 = Date.now();
    const d: any = (await x.svc.getDashboard(x.s.sellerId, x.s.storeId, tok(x.s, 'manager'))).data;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(d.summary.totalTransactions).toBe(601);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const plan: any = await h.repos.saleModel.find({ storeId: x.s.storeId, createdAt: { $gte: start }, status: { $in: ['completed', 'partially_refunded'] } }).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  });
});

describe('POS catalog edits (manager approval, audit, storefront visibility)', () => {
  const fakeInventory = () => {
    const calls: any[] = [];
    return { calls, adjustStock: jest.fn(async (_seller: string, _store: string, variantId: string, delta: number, reason: string, note?: string) => {
      calls.push({ variantId, delta, reason, note });
      await h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(variantId) }, { $inc: { stock: delta } });
      return { success: true, data: { delta, reason } };
    }) };
  };
  const setup = async (opts: Parameters<typeof seedStore>[1] = {}) => {
    const x = await fresh(opts);
    const inv = fakeInventory();
    const cat = new PosCatalogService({ repositories: h.repos } as any, x.svc, inv as any);
    return { ...x, cat, inv };
  };
  const audit = (storeId: string, action: string) => h.repos.posAuditLogModel.find({ storeId, action }).lean() as Promise<any[]>;
  const variantOf = (id: string) => h.repos.productVariantModel.collection.findOne({ _id: new Types.ObjectId(id) }) as Promise<any>;

  it('only a manager may edit: a cashier or no PIN session is refused and nothing changes', async () => {
    const x = await setup();
    await expect(x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { price: 12 } as any, tok(x.s, 'cashier'))).rejects.toThrow(/Only managers can edit the catalog/);
    await expect(x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { price: 12 } as any, undefined)).rejects.toThrow(/PIN session is required/);
    expect((await variantOf(x.s.variantId)).price).toBe(10);
    await expect(x.cat.updateVariant(oidStr(), x.s.storeId, x.s.variantId, { price: 12 } as any, tok(x.s, 'manager'))).rejects.toBeDefined();
  });

  it('a price edit changes the shared variant (the storefront reads it), is audited with before/after, and the next sale uses it', async () => {
    const x = await setup();
    const r: any = await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { price: 12.5, note: 'supplier increase' }, tok(x.s, 'manager'));
    expect(r.data).toMatchObject({ changed: ['price'], before: { price: 10 }, after: { price: 12.5 } });
    expect((await variantOf(x.s.variantId)).price).toBe(12.5);
    const a = (await audit(x.s.storeId, 'catalog_variant_updated'))[0];
    expect(a).toMatchObject({ employeeId: x.s.managerId, targetId: x.s.variantId, targetType: 'variant' });
    expect(a.metadata).toMatchObject({ sku: 'TEA-1', before: { price: 10 }, after: { price: 12.5 }, note: 'supplier increase' });
    expect((await sell(x)).total).toBe(12.5);
    // the old price is kept (briefly) for offline-sale checks, by the variant's own model hook
    expect(await h.repos.variantPriceHistoryModel.countDocuments({ variantId: x.s.variantId })).toBe(1);
  });

  it.each([['USD', 2, 10.123, 'PRICE_PRECISION'], ['JPY', 0, 100.5, 'PRICE_PRECISION'], ['KWD', 3, 10.1234, 'PRICE_PRECISION'], ['USD', 2, 0, 'PRICE_INVALID'], ['USD', 2, -3, 'PRICE_INVALID']] as const)(
    'a price must be exact in the currency\'s minor units — %s %s → %s', async (cur, _exp, price, expected) => {
      const x = await setup({ baseCurrency: cur });
      expect(await code(x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { price } as any, tok(x.s, 'manager')))).toBe(expected);
      expect((await variantOf(x.s.variantId)).price).toBe(10);
    });

  it('valid prices at the currency\'s own precision are accepted (JPY 150, KWD 10.125)', async () => {
    const j = await setup({ baseCurrency: 'JPY' });
    await j.cat.updateVariant(j.s.sellerId, j.s.storeId, j.s.variantId, { price: 150 } as any, tok(j.s, 'manager'));
    expect((await variantOf(j.s.variantId)).price).toBe(150);
    const k = await setup({ baseCurrency: 'KWD' });
    await k.cat.updateVariant(k.s.sellerId, k.s.storeId, k.s.variantId, { price: 10.125 } as any, tok(k.s, 'manager'));
    expect((await variantOf(k.s.variantId)).price).toBe(10.125);
  });

  it('a barcode is unique PER STORE: a clash is refused (409), another store may use the same code, clearing works, and the POS lookup follows the change', async () => {
    const x = await setup(); const y = await setup();
    // a second variant in store x
    const p2 = oidStr(); const v2 = oidStr();
    await h.repos.productModel.collection.insertOne({ _id: new Types.ObjectId(p2), storeId: x.s.storeId, sellerId: x.s.sellerId, name: 'Coffee', slug: `coffee-${p2}`, type: 'physical', isDelete: false, status: 'active', gallery: [], categoryId: oidStr() });
    await h.repos.productVariantModel.collection.insertOne({ _id: new Types.ObjectId(v2), productId: p2, storeId: x.s.storeId, sku: 'COF-1', price: 5, stock: 5, isDelete: false, status: 'active', options: [], isDefault: true });
    await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { barcode: '8964000012345' } as any, tok(x.s, 'manager'));
    expect(await code(x.cat.updateVariant(x.s.sellerId, x.s.storeId, v2, { barcode: '8964000012345' } as any, tok(x.s, 'manager')))).toBe('BARCODE_IN_USE');
    expect((await variantOf(v2)).barcode ?? null).toBeNull();
    // a DIFFERENT store may use the same barcode …
    await y.cat.updateVariant(y.s.sellerId, y.s.storeId, y.s.variantId, { barcode: '8964000012345' } as any, tok(y.s, 'manager'));
    // … and each store's scanner finds ITS OWN item
    expect(String(((await x.svc.getProductByBarcode(x.s.sellerId, x.s.storeId, '8964000012345')) as any).data.variant.variantId)).toBe(x.s.variantId);
    expect(String(((await y.svc.getProductByBarcode(y.s.sellerId, y.s.storeId, '8964000012345')) as any).data.variant.variantId)).toBe(y.s.variantId);
    // re-saving the same barcode on the same item is fine; clearing it removes it
    await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { barcode: '8964000012345' } as any, tok(x.s, 'manager'));
    await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { barcode: null } as any, tok(x.s, 'manager'));
    expect((await variantOf(x.s.variantId)).barcode).toBeNull();
    await expect(x.svc.getProductByBarcode(x.s.sellerId, x.s.storeId, '8964000012345')).rejects.toThrow(/not found/i);
    // a legacy variant (no storeId on it) is still matched through its product
    await h.repos.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(v2) }, { $set: { barcode: '111222333', storeId: null } });
    expect(await code(x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { barcode: '111222333' } as any, tok(x.s, 'manager')))).toBe('BARCODE_IN_USE');
  });

  it('PCT / HS code and category edits are audited and land on the shared documents; a category the store cannot use is refused', async () => {
    const x = await setup(); const y = await setup();
    const global = oidStr(); const own = oidStr(); const foreign = oidStr();
    await h.repos.categoryModel.collection.insertMany([
      { _id: new Types.ObjectId(global), name: 'Drinks', storeId: null, isDelete: false },
      { _id: new Types.ObjectId(own), name: 'Mine', storeId: x.s.storeId, isDelete: false },
      { _id: new Types.ObjectId(foreign), name: 'Theirs', storeId: y.s.storeId, isDelete: false },
    ] as any);
    const r: any = await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { hsCode: '09024090', categoryId: global }, tok(x.s, 'manager'));
    expect(r.data.changed.sort()).toEqual(['categoryId', 'hsCode']);
    expect((await variantOf(x.s.variantId)).hsCode).toBe('09024090');
    expect(String(((await h.repos.productModel.collection.findOne({ _id: new Types.ObjectId(x.s.productId) })) as any).categoryId)).toBe(global);
    await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { categoryId: own, hsCode: null } as any, tok(x.s, 'manager'));
    expect((await variantOf(x.s.variantId)).hsCode).toBeNull();
    expect(await code(x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { categoryId: foreign } as any, tok(x.s, 'manager')))).toBe('CATEGORY_NOT_FOUND');
    expect(await code(x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { categoryId: oidStr() } as any, tok(x.s, 'manager')))).toBe('CATEGORY_NOT_FOUND');
    const logs = await audit(x.s.storeId, 'catalog_variant_updated');
    expect(logs.find((l) => l.metadata.after.hsCode === '09024090').metadata).toMatchObject({ before: { hsCode: null }, after: { hsCode: '09024090' } });
    expect(logs).toHaveLength(2);
  });

  it('an item of another store cannot be edited through this store; an unchanged request changes nothing and writes no audit row', async () => {
    const x = await setup(); const y = await setup();
    await expect(x.cat.updateVariant(x.s.sellerId, x.s.storeId, y.s.variantId, { price: 99 } as any, tok(x.s, 'manager'))).rejects.toThrow(/not found/i);
    expect((await variantOf(y.s.variantId)).price).toBe(10);
    const r: any = await x.cat.updateVariant(x.s.sellerId, x.s.storeId, x.s.variantId, { price: 10 } as any, tok(x.s, 'manager'));
    expect(r.data.changed).toEqual([]);
    expect((await audit(x.s.storeId, 'catalog_variant_updated')).length).toBe(0);
  });

  it('stock goes through the inventory STOCK-MOVEMENT path (never an overwrite), only for a manager, and is audited with before/after', async () => {
    const x = await setup();
    await expect(x.cat.adjustStock(x.s.sellerId, x.s.storeId, x.s.variantId, { delta: 5, reason: 'restocked' } as any, tok(x.s, 'cashier'))).rejects.toThrow(/Only managers/);
    expect(x.inv.calls).toEqual([]);
    const r: any = await x.cat.adjustStock(x.s.sellerId, x.s.storeId, x.s.variantId, { delta: -7, reason: 'damaged', note: 'dropped box' } as any, tok(x.s, 'manager'));
    expect(x.inv.calls).toEqual([{ variantId: x.s.variantId, delta: -7, reason: 'damaged', note: 'dropped box' }]);
    expect(r.data).toMatchObject({ before: 100, after: 93 });
    expect((await audit(x.s.storeId, 'catalog_stock_adjusted'))[0].metadata).toMatchObject({ before: { stock: 100 }, after: { stock: 93 }, delta: -7, reason: 'damaged' });
    expect(await code(x.cat.adjustStock(x.s.sellerId, x.s.storeId, x.s.variantId, { delta: 0, reason: 'correction' } as any, tok(x.s, 'manager')))).toBe('DELTA_REQUIRED');
    const u = await setup({ unlimited: true });
    expect(await code(u.cat.adjustStock(u.s.sellerId, u.s.storeId, u.s.variantId, { delta: 1, reason: 'correction' } as any, tok(u.s, 'manager')))).toBe('UNLIMITED_STOCK');
  });

  it('the request bodies are validated: HS code format, barcode length, delta must be a whole number, reason must be a known one', async () => {
    const bad = async (cls: any, body: any) => (await validate(plainToInstance(cls, body))).map((e) => e.property);
    expect(await bad(UpdateCatalogVariantDto, { hsCode: 'abc' })).toContain('hsCode');
    expect(await bad(UpdateCatalogVariantDto, { hsCode: '0902.40.90' })).toEqual([]);
    expect(await bad(UpdateCatalogVariantDto, { barcode: 'x'.repeat(65) })).toContain('barcode');
    expect(await bad(UpdateCatalogVariantDto, { categoryId: 'nope' })).toContain('categoryId');
    expect(await bad(AdjustCatalogStockDto, { delta: 1.5, reason: 'correction' })).toContain('delta');
    expect(await bad(AdjustCatalogStockDto, { delta: 1, reason: 'because' })).toContain('reason');
    expect(await bad(AdjustCatalogStockDto, { delta: 3, reason: 'correction' })).toEqual([]);
  });
});

describe('store tax profile (owner route)', () => {
  it('NTN, STRN, registered name and address and a default tax category are saved, validated and returned; all optional', async () => {
    const x = await fresh();
    const before: any = (await x.svc.getPosSettings(x.s.sellerId, x.s.storeId)).data;
    expect(before).toMatchObject({ taxNtn: null, taxStrn: null, taxLegalName: null, taxRegisteredAddress: null, defaultTaxCategory: 'standard' });
    await x.svc.updatePosSettings(x.s.sellerId, x.s.storeId, { taxNtn: '1234567-8', taxStrn: '3277876123456', taxLegalName: 'Test Traders (Pvt) Ltd', taxRegisteredAddress: '12 Mall Road, Lahore', defaultTaxCategory: 'exempt' } as any);
    expect(((await x.svc.getPosSettings(x.s.sellerId, x.s.storeId)) as any).data).toMatchObject({ taxNtn: '1234567-8', taxStrn: '3277876123456', taxLegalName: 'Test Traders (Pvt) Ltd', defaultTaxCategory: 'exempt' });
    const v = async (body: any) => (await validate(plainToInstance(UpdatePosSettingsDto, body))).map((e) => e.property);
    expect(await v({ taxNtn: 'abc' })).toContain('taxNtn');
    expect(await v({ taxStrn: '!!' })).toContain('taxStrn');
    expect(await v({ defaultTaxCategory: 'weird' })).toContain('defaultTaxCategory');
    expect(await v({ taxNtn: null, taxStrn: null, taxLegalName: null })).toEqual([]);
    const audit: any = await h.repos.posAuditLogModel.findOne({ storeId: x.s.storeId, action: 'settings_updated' }).lean();
    expect(audit.metadata.fields).toEqual(expect.arrayContaining(['taxNtn']));
  });

  it('the default tax category decides a custom item that does not say; an explicit choice always wins', async () => {
    const x = await fresh({ taxRate: 0.1 });
    await h.repos.posSettingsModel.collection.updateOne({ storeId: x.s.storeId }, { $set: { customItemApprovalAboveMinor: 100000, defaultTaxCategory: 'exempt' } });
    const a = await sell(x, { items: [{ isCustom: true, customName: 'Fee', unitPrice: 10, qty: 1 }] });
    expect([a.items[0].taxCategory, a.tax]).toEqual(['exempt', 0]);
    const b = await sell(x, { items: [{ isCustom: true, customName: 'Fee', unitPrice: 10, qty: 1, taxCategory: 'standard' }] });
    expect([b.items[0].taxCategory, b.tax]).toEqual(['standard', 1]);
  });
});
