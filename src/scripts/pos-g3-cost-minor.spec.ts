/* eslint-disable prettier/prettier */
import mongoose, { Types } from 'mongoose';
import { EJSON } from 'bson';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { StockUnitSchema } from '../inventory/schemas/stock-unit.schema';
import { StockTransferSchema } from '../inventory/schemas/stock-transfer.schema';
import { BinSchema } from '../inventory/schemas/bin.schema';
import { StockCountSchema } from '../stock-counts/schemas/stock-count.schema';
import { PurchaseOrderSchema } from '../purchase-orders/schemas/purchase-order.schema';
import { SupplierReturnSchema } from '../purchase-orders/schemas/supplier-return.schema';
import { ApprovalRequestSchema } from '../staff/schemas/approval-request.schema';
import { InventoryService } from '../inventory/inventory.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { SupplierReturnsService } from '../purchase-orders/supplier-returns.service';
import { checkCostMinor } from '../common/cost-minor.util';
import { omitCostPrice } from '../common/product-cost-visibility.util';
import { assertSafeTarget, backfillCostMinor, backfillCostMinorDown, G3C } from './pos-g3-cost-minor-backfill.lib';

/** G3.0 money twins on a real MongoDB: dual-write parity at every write site, the checker, and the backfill (dry run, idempotent, resumable, reversible). */
jest.setTimeout(240_000);
let h: MongoHarness;
let r: any; let pos: PurchaseOrdersService; let returns: SupplierReturnsService;
const oid = () => new Types.ObjectId();
let STORE: string; let SELLER: string; let JPY_STORE: string;
const db = () => h.conn.db!;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const conn = h.conn;
  r = {
    ...h.repos,
    stockAdjustmentModel: conn.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: conn.model('StockLot', StockLotSchema), stockUnitModel: conn.model('StockUnit', StockUnitSchema),
    stockTransferModel: conn.model('StockTransfer', StockTransferSchema), binModel: conn.model('Bin', BinSchema), stockCountModel: conn.model('StockCount', StockCountSchema),
    purchaseOrderModel: conn.model('PurchaseOrder', PurchaseOrderSchema), supplierReturnModel: conn.model('SupplierReturn', SupplierReturnSchema),
    supplierModel: conn.model('Supplier', new mongoose.Schema({}, { strict: false })), approvalRequestModel: conn.model('ApprovalRequest', ApprovalRequestSchema),
    staffMemberModel: conn.model('StaffMember', new mongoose.Schema({ name: String }, { strict: false })),
  };
  const dbs: any = { repositories: r };
  const activity: any = { log: jest.fn(async () => undefined) };
  const inv = new InventoryService(dbs, { isConnected: false } as any, { notify: jest.fn() } as any, conn as any);
  returns = new SupplierReturnsService(dbs, activity, inv, conn as any); returns.onModuleInit();
  pos = new PurchaseOrdersService(dbs, activity, inv, { notify: jest.fn() } as any, { sendMail: jest.fn() } as any, { get: jest.fn() } as any, conn as any);
  SELLER = String(oid()); const st = oid(); STORE = String(st); const jp = oid(); JPY_STORE = String(jp);
  await r.sellerModel.collection.insertOne({ _id: new Types.ObjectId(SELLER), name: 'Seller', status: 'active', isDelete: false });
  await r.storeModel.collection.insertMany([
    { _id: st, sellerId: SELLER, status: 'active', isDelete: false, baseCurrency: 'USD', name: 'S', slug: 's' },
    { _id: jp, sellerId: SELLER, status: 'active', isDelete: false, baseCurrency: 'JPY', name: 'J', slug: 'j' },
  ]);
});
afterAll(async () => { await h?.stop(); });

const mkVariant = async (stock: number, extra: any = {}, store = STORE) => {
  const pid = oid();
  await r.productModel.collection.insertOne({ _id: pid, storeId: store, sellerId: SELLER, isDelete: false, status: 'active', type: 'physical', name: 'P' + pid, slug: 's' + pid });
  const vid = oid();
  await r.productVariantModel.collection.insertOne({ _id: vid, productId: String(pid), storeId: store, sku: 'SKU-' + vid, price: 5, stock, committedStock: 0, damagedStock: 0, inTransitStock: 0, isDelete: false, isDefault: true, options: [], unlimitedStock: false, ...extra });
  return { pid: String(pid), vid: String(vid) };
};
const mkPo = async (vid: string, pid: string, qty: number, unitCost: number, currency = 'USD', store = STORE) => {
  const id = oid();
  // written the way the service writes a PO (through the model → the schema hook)
  const po: any = await r.purchaseOrderModel.create({ _id: id, storeId: store, sellerId: SELLER, supplierName: 'Sup', poNumber: 'PO-' + id, status: 'ordered', receivedRequestIds: [], currency, createdBy: SELLER,
    items: [{ productId: pid, variantId: vid, name: 'Item', sku: 'S', options: [], quantityOrdered: qty, quantityReceived: 0, quantityDamaged: 0, unitCost }], subtotal: qty * unitCost, shippingCost: 1.5, taxCost: 0.25, total: qty * unitCost + 1.75 });
  return { id: String(id), itemId: String(po.items[0]._id) };
};

describe('dual-write parity at every write site', () => {
  it('a purchase order carries the twins of its totals and lines, from the SAME decimals, in its own currency (USD ×100, JPY ×1)', async () => {
    const a = await mkVariant(0); const p1 = await mkPo(a.vid, a.pid, 4, 2.55);
    const doc: any = await r.purchaseOrderModel.findById(p1.id).lean();
    expect([doc.subtotalMinor, doc.shippingCostMinor, doc.taxCostMinor, doc.totalMinor, doc.items[0].unitCostMinor]).toEqual([1020, 150, 25, 1195, 255]);
    expect(checkCostMinor('purchaseOrder', doc, 2)).toEqual([]);
    const b = await mkVariant(0, {}, JPY_STORE); const p2 = await mkPo(b.vid, b.pid, 3, 120, 'JPY', JPY_STORE);
    const jdoc: any = await r.purchaseOrderModel.findById(p2.id).lean();
    expect([jdoc.subtotalMinor, jdoc.items[0].unitCostMinor]).toEqual([360, 120]); // exponent 0: minor = major
    expect(checkCostMinor('purchaseOrder', jdoc, 0)).toEqual([]);
    // an edit through save() re-derives them
    const live = await r.purchaseOrderModel.findById(p1.id); live.shippingCost = 3; live.total = 13.2; await live.save();
    const after: any = await r.purchaseOrderModel.findById(p1.id).lean();
    expect([after.shippingCostMinor, after.totalMinor]).toEqual([300, 1320]);
  });

  it('PO receive: the variant cost AND the lot cost get their twins (weighted-average cost kept); the checker finds nothing', async () => {
    const { vid, pid } = await mkVariant(10, { costPrice: 1, costPriceMinor: 100, trackLots: true });
    const { id, itemId } = await mkPo(vid, pid, 10, 2.5);
    await pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 10, lotNumber: 'L1' }] } as any);
    const v: any = await r.productVariantModel.findById(vid).lean();
    expect(v.costPrice).toBe(1.75); // (10×1 + 10×2.5)/20
    expect(v.costPriceMinor).toBe(175);
    const lot: any = await r.stockLotModel.findOne({ variantId: vid }).lean();
    expect([lot.costPrice, lot.costPriceMinor]).toEqual([2.5, 250]);
    expect(checkCostMinor('variant', v, 2)).toEqual([]);
    expect(checkCostMinor('stockLot', lot, 2)).toEqual([]);
    const po: any = await r.purchaseOrderModel.findById(id).lean();
    expect(checkCostMinor('purchaseOrder', po, 2)).toEqual([]);
  });

  it('a supplier return keeps its currency and twins, and re-weights the variant cost with its twin', async () => {
    const { vid } = await mkVariant(10, { costPrice: 2, costPriceMinor: 200 });
    const out: any = await returns.create(STORE, SELLER, { supplierName: 'Acme', reason: 'defective', items: [{ variantId: vid, quantity: 4, unitCost: 1.5 }] } as any);
    const sr: any = await r.supplierReturnModel.findById(out.data._id).lean();
    expect([sr.currency, sr.totalCredit, sr.totalCreditMinor, sr.items[0].unitCostMinor]).toEqual(['USD', 6, 600, 150]);
    expect(checkCostMinor('supplierReturn', sr, 2)).toEqual([]);
    const v: any = await r.productVariantModel.findById(vid).lean();
    expect(v.costPriceMinor).toBe(Math.round(v.costPrice * 100));
  });

  it('the checker reports a pair that disagrees (a bug in a future write site cannot hide)', () => {
    expect(checkCostMinor('variant', { costPrice: 1.75, costPriceMinor: 176 }, 2)).toHaveLength(1);
    expect(checkCostMinor('variant', { costPrice: null, costPriceMinor: null }, 2)).toEqual([]);
    expect(checkCostMinor('variant', { costPrice: 1.75 }, 2)).toEqual([]); // legacy row: the backfill's job
  });

  it('the twin is margin data too: it never reaches a public variant', () => {
    expect(omitCostPrice({ price: 5, costPrice: 1, costPriceMinor: 100 })).toEqual({ price: 5 });
  });
});

describe('backfill', () => {
  const wipe = async () => { for (const c of await db().listCollections().toArray()) if (c.name !== 'stores' && c.name !== 'sellers') await db().collection(c.name).deleteMany({}); };
  const snap = async () => { const out: Record<string, string> = {}; for (const c of await db().listCollections().toArray()) out[c.name] = EJSON.stringify(await db().collection(c.name).find({}).sort({ _id: 1 }).toArray()); return out; };
  /** rows as written before G3.0: decimals only */
  async function legacy() {
    const a = await mkVariant(5, { costPrice: 1.25 }); // variant cost, no twin
    const j = await mkVariant(5, { costPrice: 120 }, JPY_STORE);
    const off = await mkVariant(5, { costPrice: 1.2345 }); // sub-minor precision (a weighted average)
    await mkVariant(5); // no cost at all: stays untouched
    const poId = oid();
    await r.purchaseOrderModel.collection.insertOne({ _id: poId, storeId: STORE, sellerId: SELLER, supplierName: 'Old', poNumber: 'PO-OLD', status: 'received', receivedRequestIds: [], currency: 'USD', createdBy: SELLER, createdAt: new Date(), updatedAt: new Date(),
      items: [{ _id: oid(), productId: a.pid, variantId: a.vid, name: 'I', quantityOrdered: 2, quantityReceived: 2, quantityDamaged: 0, unitCost: 3.1 }, { _id: oid(), productId: a.pid, variantId: a.vid, name: 'J', quantityOrdered: 1, quantityReceived: 1, quantityDamaged: 0, unitCost: 0.99 }], subtotal: 7.19, shippingCost: 2, taxCost: 0, total: 9.19 });
    await r.supplierReturnModel.collection.insertOne({ _id: oid(), storeId: STORE, sellerId: SELLER, returnNumber: 'SR-OLD', supplierName: 'Old', items: [{ _id: oid(), productId: a.pid, variantId: a.vid, name: 'I', quantity: 2, unitCost: 3.1 }], totalCredit: 6.2, creditStatus: 'pending', createdBy: SELLER, createdAt: new Date() });
    await r.stockLotModel.collection.insertOne({ _id: oid(), storeId: STORE, productId: a.pid, variantId: a.vid, lotNumber: 'L-OLD', quantityReceived: 5, quantityRemaining: 5, costPrice: 2.2, status: 'active', receivedAt: new Date() });
    return { a, j, off };
  }

  it('refuses a non-dev database without both production flags', () => {
    expect(() => assertSafeTarget('solvexo_prod', {})).toThrow(/Refusing/);
    expect(() => assertSafeTarget('solvexo_prod', { production: true, iHaveABackup: true })).not.toThrow();
  });

  it('dry run writes nothing; up fills every twin (each store\'s own exponent), reports the off-grid cost; a second run writes 0', async () => {
    await wipe();
    const l = await legacy();
    const before = await snap();
    const dry = await backfillCostMinor(db(), { dryRun: true });
    expect(await snap()).toEqual(before);
    const cand = Object.fromEntries(dry.collections.map((c) => [c.collection, c.candidates]));
    expect(cand[G3C.variants]).toBe(3);
    expect(cand[G3C.po]).toBeGreaterThanOrEqual(1);

    const up = await backfillCostMinor(db(), { dryRun: false });
    const by = Object.fromEntries(up.collections.map((c) => [c.collection, c]));
    expect(by[G3C.variants].offGrid.map((o) => o.value)).toEqual([1.2345]);
    const v = async (id: string): Promise<any> => db().collection(G3C.variants).findOne({ _id: new Types.ObjectId(id) });
    expect([(await v(l.a.vid)).costPriceMinor, (await v(l.j.vid)).costPriceMinor, (await v(l.off.vid)).costPriceMinor]).toEqual([125, 120, 123]); // JPY exponent 0; 1.2345 → 123 (decimal keeps the rest)
    const po: any = await db().collection(G3C.po).findOne({ poNumber: 'PO-OLD' });
    expect([po.subtotalMinor, po.shippingCostMinor, po.totalMinor, po.items.map((i: any) => i.unitCostMinor)]).toEqual([719, 200, 919, [310, 99]]);
    const sr: any = await db().collection(G3C.returns).findOne({ returnNumber: 'SR-OLD' });
    expect([sr.currency, sr.totalCreditMinor, sr.items[0].unitCostMinor]).toEqual(['USD', 620, 310]);
    expect((await db().collection(G3C.lots).findOne({ lotNumber: 'L-OLD' }))!.costPriceMinor).toBe(220);
    // no cost → no twin invented
    expect(await db().collection(G3C.variants).countDocuments({ costPrice: null, costPriceMinor: { $nin: [null] } })).toBe(0);
    // every backfilled row passes the checker
    for (const row of await db().collection(G3C.variants).find({ costMinorBackfilledAt: { $exists: true }, 'costPrice': { $ne: 1.2345 } }).toArray()) {
      const store = String((row as any).storeId) === JPY_STORE ? 0 : 2;
      expect(checkCostMinor('variant', row, store)).toEqual([]);
    }
    expect(checkCostMinor('purchaseOrder', po, 2)).toEqual([]);

    const again = await backfillCostMinor(db(), { dryRun: false });
    expect(again.collections.reduce((s, c) => s + c.written, 0)).toBe(0);
  });

  it('is resumable (--max-docs slices; the sum is the same) and never overwrites a row a live write already twinned', async () => {
    await wipe();
    await legacy();
    await backfillCostMinor(db(), { dryRun: false, maxDocs: 2 });
    const mid = await db().collection(G3C.variants).countDocuments({ costMinorBackfilledAt: { $exists: true } }) + await db().collection(G3C.po).countDocuments({ costMinorBackfilledAt: { $exists: true } }) + await db().collection(G3C.returns).countDocuments({ costMinorBackfilledAt: { $exists: true } }) + await db().collection(G3C.lots).countDocuments({ costMinorBackfilledAt: { $exists: true } });
    expect(mid).toBe(2);
    // a live write twins a variant with a DIFFERENT (newer) cost before the rest runs
    const live = await db().collection(G3C.variants).findOne({ costPrice: 120 });
    if (live && live.costPriceMinor == null) await db().collection(G3C.variants).updateOne({ _id: live._id }, { $set: { costPrice: 130, costPriceMinor: Long130() } });
    await backfillCostMinor(db(), { dryRun: false });
    const j: any = await db().collection(G3C.variants).findOne({ _id: live!._id });
    expect([j.costPrice, Number(j.costPriceMinor)]).toEqual([130, 130]);
    expect(j.costMinorBackfilledAt).toBeUndefined(); // the backfill did not touch it
  });

  it('down removes exactly what up added: the database is byte for byte what it was', async () => {
    await wipe();
    await legacy();
    const before = await snap();
    await backfillCostMinor(db(), { dryRun: false });
    expect(await snap()).not.toEqual(before);
    const dry = await backfillCostMinorDown(db(), { dryRun: true });
    expect(dry.reduce((s, x) => s + x.rows, 0)).toBeGreaterThan(0);
    await backfillCostMinorDown(db(), { dryRun: false });
    expect(await snap()).toEqual(before);
  });
});

function Long130() { return require('mongodb').Long.fromNumber(130); }
