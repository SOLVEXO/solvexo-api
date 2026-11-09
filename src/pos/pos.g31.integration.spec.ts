/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosInventoryService } from './pos-inventory.service';
import { MongoHarness, oidStr, seedStore, startMongoHarness } from './testing/mongo-harness';
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
import { StockCountsService } from '../stock-counts/stock-counts.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';

/** G3.1 on a real replica-set MongoDB: the stock ledger, the cost snapshot, the permission matrix on the till-facing inventory routes, counts by scan. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let inv: PosInventoryService; let po: PurchaseOrdersService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const conn = h.conn;
  Object.assign(h.repos, {
    stockAdjustmentModel: conn.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: conn.model('StockLot', StockLotSchema), stockUnitModel: conn.model('StockUnit', StockUnitSchema),
    stockTransferModel: conn.model('StockTransfer', StockTransferSchema), binModel: conn.model('Bin', BinSchema), stockCountModel: conn.model('StockCount', StockCountSchema),
    purchaseOrderModel: conn.model('PurchaseOrder', PurchaseOrderSchema), supplierReturnModel: conn.model('SupplierReturn', SupplierReturnSchema),
    supplierModel: conn.model('Supplier', new mongoose.Schema({}, { strict: false })), approvalRequestModel: conn.model('ApprovalRequest', ApprovalRequestSchema),
    staffMemberModel: conn.model('StaffMember', new mongoose.Schema({ name: String }, { strict: false })),
  });
  r = h.repos;
  await Promise.all(['stockAdjustmentModel', 'stockCountModel', 'purchaseOrderModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  const activity: any = { log: jest.fn(async () => undefined) };
  svc = new PosService(dbs, activity, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const invSvc = new InventoryService(dbs, { isConnected: false } as any, { notify: jest.fn() } as any, conn as any);
  const counts = new StockCountsService(dbs, activity, conn as any);
  po = new PurchaseOrdersService(dbs, activity, invSvc, { notify: jest.fn() } as any, { sendMail: jest.fn() } as any, { get: jest.fn() } as any, conn as any);
  inv = new PosInventoryService(dbs, svc, new PosAuthorizer(dbs, svc), invSvc, counts);
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const moves = (storeId: string, q: any = {}) => r.stockMovementModel.find({ storeId, ...q }).sort({ createdAt: 1, _id: 1 }).lean();

async function fresh(opts: Parameters<typeof seedStore>[1] & { cost?: number } = {}) {
  const s = await seedStore(h, { stock: 50, price: 10, ...opts });
  if (opts.cost !== undefined) await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { costPrice: opts.cost, costPriceMinor: Math.round(opts.cost * 100), reorderPoint: 10 } });
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(), openingCash: 50, totalSales: 0, totalTransactions: 0 });
  const sell = async (qty = 1, over: any = {}) => ((await svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty }], paymentMethod: 'cash', ...over } as any, tok(s, 'manager'))) as any).data;
  return { s, sid, sell };
}
const stock = async (variantId: string) => (await r.productVariantModel.findById(variantId).lean()).stock;

describe('the stock ledger: sale / return / void rows are written with their document, at the cost snapshot', () => {
  it('a sale writes one movement per tracked line (−qty) and snapshots the unit cost on the sale line; a later cost change never rewrites it', async () => {
    const { s, sell } = await fresh({ cost: 1.25 });
    const sale = await sell(3);
    expect(sale.items[0].unitCostMinor).toBe(125);
    const m: any[] = await moves(s.storeId);
    expect(m).toHaveLength(1);
    expect([m[0].type, m[0].qtyDelta, m[0].unitCostMinor, m[0].refType, m[0].refId, m[0].variantId]).toEqual(['sale', -3, 125, 'sale', String(sale._id), s.variantId]);
    expect([m[0].registerId, m[0].sessionId, m[0].employeeId]).toEqual([s.registerId, expect.any(String), s.cashierId]);
    await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { costPrice: 9, costPriceMinor: 900 } });
    const again: any = await r.saleModel.findById(sale._id).lean();
    expect(again.items[0].unitCostMinor).toBe(125); // profit reports read THIS, not the live cost
    expect((await moves(s.storeId))[0].unitCostMinor).toBe(125);
  });

  it('a variant with no cost records null (not zero); a decimal-only cost is converted by the store exponent; unlimited stock and held sales write nothing', async () => {
    const a = await fresh();
    await a.sell(1);
    expect((await moves(a.s.storeId))[0].unitCostMinor).toBeNull();
    const b = await fresh({ unlimited: true }); await b.sell(2);
    expect(await moves(b.s.storeId)).toHaveLength(0);
    const c = await fresh({ cost: 2 }); await c.sell(1, { status: 'held' });
    expect(await moves(c.s.storeId)).toHaveLength(0);
    const d = await fresh(); await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(d.s.variantId) }, { $set: { costPrice: 3.1 }, $unset: { costPriceMinor: '' } });
    const ds = await d.sell(1);
    expect(ds.items[0].unitCostMinor).toBe(310);
  });

  it('a sale that fails (not enough stock) leaves no movement and no stock change', async () => {
    const { s, sell } = await fresh({ cost: 1, stock: 2 });
    expect(await code(sell(5))).not.toBeNull();
    expect(await moves(s.storeId)).toHaveLength(0);
    expect(await stock(s.variantId)).toBe(2);
  });

  it('a retried sale (same idempotency key) is ONE sale and ONE movement', async () => {
    const { s, sell } = await fresh({ cost: 1 });
    await sell(2, { idempotencyKey: 'k-1' }); await sell(2, { idempotencyKey: 'k-1' }).catch(() => undefined);
    expect(await moves(s.storeId, { type: 'sale' })).toHaveLength(1);
  });

  it('a return puts restocked units back (+qty at the SALE\'s cost); a line not restocked writes nothing; a void puts everything back', async () => {
    const { s, sell } = await fresh({ cost: 1.25 });
    const sale = await sell(4);
    await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { costPrice: 2, costPriceMinor: 200 } }); // cost moves on
    const line = sale.items[0]._id;
    await svc.refundSale(s.sellerId, String(sale._id), { items: [{ saleItemId: String(line), qty: 1 }] } as any, tok(s, 'manager'));
    await svc.refundSale(s.sellerId, String(sale._id), { items: [{ saleItemId: String(line), qty: 1, restock: false, restockReason: 'spilled' }] } as any, tok(s, 'manager'));
    const m: any[] = await moves(s.storeId);
    expect(m.map((x) => [x.type, x.qtyDelta, x.unitCostMinor])).toEqual([['sale', -4, 125], ['return', 1, 125]]);
    const v = await fresh({ cost: 1.25 }); const s2 = await v.sell(2);
    await svc.voidSale(v.s.sellerId, String(s2._id), {} as any, tok(v.s, 'manager'));
    expect((await moves(v.s.storeId)).map((x: any) => [x.type, x.qtyDelta])).toEqual([['sale', -2], ['void', 2]]);
  });

  it('the ledger reconciles with the stock: start + Σ movements = what the variant holds (sales, returns, voids, adjustments, a purchase receipt)', async () => {
    const { s, sell } = await fresh({ cost: 1, stock: 100 });
    const a = await sell(5); const b = await sell(3);
    await svc.refundSale(s.sellerId, String(a._id), { items: [{ saleItemId: String(a.items[0]._id), qty: 2 }] } as any, tok(s, 'manager'));
    await svc.voidSale(s.sellerId, String(b._id), {} as any, tok(s, 'manager'));
    await inv.adjust(owner(s), s.storeId, s.variantId, { delta: 7, reason: 'restocked' }, { employee: undefined });
    await inv.adjust(owner(s), s.storeId, s.variantId, { delta: -2, reason: 'damaged' }, { employee: undefined });
    await inv.adjust(owner(s), s.storeId, s.variantId, { delta: -1, reason: 'correction' }, { employee: undefined });
    const sum = (await moves(s.storeId)).reduce((t: number, m: any) => t + m.qtyDelta, 0);
    expect(100 + sum).toBe(await stock(s.variantId));
  });

  it('the ledger is append-only: no update, no delete through the model', async () => {
    const { s, sell } = await fresh({ cost: 1 }); await sell(1);
    await expect(r.stockMovementModel.updateOne({ storeId: s.storeId }, { $set: { qtyDelta: 9 } })).rejects.toThrow(/append-only/);
    await expect(r.stockMovementModel.deleteMany({ storeId: s.storeId })).rejects.toThrow(/append-only/);
  });
});

describe('manual adjustments and receipts write their own movement in the same transaction', () => {
  it('an adjustment is one StockAdjustment AND one movement (type adjustment, the weighted-average cost); damaged / write-off types map', async () => {
    const { s } = await fresh({ cost: 2 });
    await inv.adjust(owner(s), s.storeId, s.variantId, { delta: 5, reason: 'restocked', note: 'delivery' }, {});
    await inv.adjust(owner(s), s.storeId, s.variantId, { delta: -1, reason: 'damaged' }, {});
    const m: any[] = await moves(s.storeId);
    expect(m.map((x) => [x.type, x.qtyDelta, x.damagedDelta, x.unitCostMinor, x.reason])).toEqual([['adjustment', 5, 0, 200, 'restocked'], ['adjustment', 0, 1, 200, 'damaged']]); // 'damaged' moves units to the damaged pool: on-hand stock is unchanged
    expect(await r.stockAdjustmentModel.countDocuments({ storeId: s.storeId })).toBe(2);
  });

  it('a PO receipt records a "receive" movement at the PO line\'s own cost', async () => {
    const { s } = await fresh({ cost: 1, stock: 10 });
    const poId = new Types.ObjectId();
    const created: any = await r.purchaseOrderModel.create({ _id: poId, storeId: s.storeId, sellerId: s.sellerId, supplierName: 'Sup', poNumber: 'PO-1', status: 'ordered', receivedRequestIds: [], currency: 'USD', createdBy: s.sellerId,
      items: [{ productId: s.productId, variantId: s.variantId, name: 'Tea', sku: 'TEA-1', options: [], quantityOrdered: 10, quantityReceived: 0, quantityDamaged: 0, unitCost: 3 }], subtotal: 30, total: 30 });
    await po.receive(s.storeId, s.sellerId, String(poId), { items: [{ itemId: String(created.items[0]._id), quantityReceived: 10 }] } as any);
    const m: any[] = await moves(s.storeId, { type: 'receive' });
    expect(m.map((x) => [x.qtyDelta, x.unitCostMinor])).toEqual([[10, 300]]);
    expect(await stock(s.variantId)).toBe(20);
  });
});

describe('the till-facing inventory routes obey the permission matrix', () => {
  it('no PIN session → POS_PIN_REQUIRED; a cashier sees stock WITHOUT cost, a manager with cost; the owner\'s own login sees cost too', async () => {
    const { s } = await fresh({ cost: 1.5, stock: 20 });
    expect(await code(inv.stock(device(s), s.storeId, {}, {}))).toBe('POS_PIN_REQUIRED');
    const c: any = (await inv.stock(device(s), s.storeId, {}, { employee: tok(s, 'cashier') })).data.items[0];
    expect([c.stock, 'costMinor' in c, 'valueMinor' in c]).toEqual([20, false, false]);
    const m: any = (await inv.stock(device(s), s.storeId, {}, { employee: tok(s, 'manager') })).data.items[0];
    expect([m.costMinor, m.valueMinor]).toEqual([150, 3000]);
    expect((await inv.stock(owner(s), s.storeId, {}, {})).data.items[0].costMinor).toBe(150);
    const ov: any = (await inv.overview(device(s), s.storeId, { employee: tok(s, 'manager') })).data;
    expect([ov.skuCount, ov.stockValueMinor, ov.role]).toEqual([1, 3000, 'manager']);
    expect('stockValueMinor' in (await inv.overview(device(s), s.storeId, { employee: tok(s, 'cashier') })).data).toBe(false);
  });

  it('movement history is manager / owner only; a cashier is refused (and the denial is audited)', async () => {
    const { s, sell } = await fresh({ cost: 1 }); await sell(1);
    expect(await code(inv.movements(device(s), s.storeId, {}, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
    const ok: any = await inv.movements(device(s), s.storeId, {}, { employee: tok(s, 'manager') });
    expect(ok.data.items.map((x: any) => [x.type, x.qtyDelta, x.unitCostMinor])).toEqual([['sale', -1, 100]]);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'pos_action_denied' })).toBeGreaterThanOrEqual(1);
  });

  it('adjust: a cashier may adjust a little (≤ the limits), needs a manager\'s PIN above them (code, then success with the approver recorded); a manager and the owner need none', async () => {
    const { s } = await fresh({ cost: 1, stock: 100 });
    const cash = { employee: tok(s, 'cashier') };
    await inv.adjust(device(s), s.storeId, s.variantId, { delta: -2, reason: 'correction' }, cash); // 2 units, 2.00 ≤ defaults (5 units, 20.00)
    const denied = await inv.adjust(device(s), s.storeId, s.variantId, { delta: -6, reason: 'correction' }, cash).catch((e) => e.response);
    expect([denied.code, denied.approver, denied.reasons]).toEqual(['POS_APPROVAL_REQUIRED', 'manager', ['stockAdjustQty']]);
    expect(await stock(s.variantId)).toBe(98);
    // the manager's PIN approves THIS use
    await inv.adjust(device(s), s.storeId, s.variantId, { delta: -6, reason: 'correction' }, { ...cash, approver: tok(s, 'manager') });
    expect(await stock(s.variantId)).toBe(92);
    const audit: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'stock_adjusted', 'metadata.delta': -6 }).lean();
    expect([audit.employeeId, audit.metadata.approvedBy, audit.metadata.role]).toEqual([s.cashierId, s.managerId, 'cashier']);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'pos_approval_given' })).toBe(1);
    // a cashier's PIN is not an approval
    expect(await code(inv.adjust(device(s), s.storeId, s.variantId, { delta: -9, reason: 'correction' }, { ...cash, approver: tok(s, 'cashier') }))).toBe('POS_APPROVAL_REQUIRED');
    // value limit independent of quantity: 3 units × 9.00 = 27.00 > 20.00
    await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { costPrice: 9, costPriceMinor: 900 } });
    expect(await code(inv.adjust(device(s), s.storeId, s.variantId, { delta: -3, reason: 'correction' }, cash))).toBe('POS_APPROVAL_REQUIRED');
    await inv.adjust(device(s), s.storeId, s.variantId, { delta: -50, reason: 'correction' }, { employee: tok(s, 'manager') });
    await inv.adjust(owner(s), s.storeId, s.variantId, { delta: 20, reason: 'restocked' }, {});
  });

  it('adjust validates: whole non-zero units, a listed reason, a note for "other"; unlimited items refused', async () => {
    const { s } = await fresh({ cost: 1 }); const m = { employee: tok(s, 'manager') };
    expect(await code(inv.adjust(device(s), s.storeId, s.variantId, { delta: 0, reason: 'damaged' }, m))).toBe('DELTA_INVALID');
    expect(await code(inv.adjust(device(s), s.storeId, s.variantId, { delta: 1.5, reason: 'damaged' }, m))).toBe('DELTA_INVALID');
    expect(await code(inv.adjust(device(s), s.storeId, s.variantId, { delta: 1, reason: 'write_off' }, m))).toBe('REASON_INVALID');
    expect(await code(inv.adjust(device(s), s.storeId, s.variantId, { delta: 1, reason: 'other' }, m))).toBe('NOTE_REQUIRED');
    const u = await fresh({ unlimited: true });
    expect(await code(inv.adjust(device(u.s), u.s.storeId, u.s.variantId, { delta: 1, reason: 'restocked' }, { employee: tok(u.s, 'manager') }))).toBe('UNLIMITED_STOCK');
  });

  it('another store\'s data is out of reach (a device is pinned to its store; a foreign variant is not found)', async () => {
    const a = await fresh({ cost: 1 }); const b = await fresh({ cost: 1 });
    expect(await code(inv.detail(device(a.s), a.s.storeId, b.s.variantId, { employee: tok(a.s, 'manager') }))).not.toBeNull();
    expect(await code(inv.adjust(device(a.s), a.s.storeId, b.s.variantId, { delta: 1, reason: 'restocked' }, { employee: tok(a.s, 'manager') }))).not.toBeNull();
  });
});

describe('approval limits (D6): the owner edits, a manager reads, an override moves the decision', () => {
  it('defaults are documented per currency; only the owner may change them; the change is audited with before / after; unknown or negative values are refused', async () => {
    const { s } = await fresh({ cost: 1, stock: 100 });
    const lim: any = (await inv.limits(device(s), s.storeId, { employee: tok(s, 'manager') })).data;
    expect(lim.limits.find((l: any) => l.key === 'cashOutMinor')).toMatchObject({ value: 10_000, defaultValue: 10_000, kind: 'minor' });
    expect(await code(inv.limits(device(s), s.storeId, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(inv.setLimits(device(s), s.storeId, { stockAdjustQty: 50 }, { employee: tok(s, 'manager') }))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(inv.setLimits(owner(s), s.storeId, { nope: 1 } as any, {}))).toBe('UNKNOWN_LIMIT');
    expect(await code(inv.setLimits(owner(s), s.storeId, { stockAdjustQty: -1 }, {}))).toBe('LIMIT_INVALID');
    await inv.setLimits(owner(s), s.storeId, { stockAdjustQty: 50 }, {});
    const au: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'approval_limits_changed' }).lean();
    expect([au.metadata.before ?? {}, au.metadata.changes]).toEqual([{}, { stockAdjustQty: 50 }]);
    // the cashier may now adjust 20 units alone
    await inv.adjust(device(s), s.storeId, s.variantId, { delta: -20, reason: 'correction' }, { employee: tok(s, 'cashier') });
    expect(await stock(s.variantId)).toBe(80);
    // another store keeps its own defaults
    const o = await fresh({ cost: 1, stock: 100 });
    expect(await code(inv.adjust(device(o.s), o.s.storeId, o.s.variantId, { delta: -20, reason: 'correction' }, { employee: tok(o.s, 'cashier') }))).toBe('POS_APPROVAL_REQUIRED');
  });
});

describe('stock count by scan', () => {
  it('a manager starts it, a cashier counts (find by barcode, enter), only a manager finishes; the variance is posted as a movement; a second open count is refused', async () => {
    const { s } = await fresh({ cost: 1, stock: 10 });
    await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { barcode: '8964000012345' } });
    expect(await code(inv.countStart(device(s), s.storeId, undefined, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
    const started: any = (await inv.countStart(device(s), s.storeId, undefined, { employee: tok(s, 'manager') })).data;
    const id = String(started._id);
    expect(await code(inv.countStart(device(s), s.storeId, undefined, { employee: tok(s, 'manager') }))).not.toBeNull(); // one open count per store
    const found: any = (await inv.countFind(device(s), s.storeId, id, '8964000012345', { employee: tok(s, 'cashier') })).data;
    expect(found.found).toBe(true);
    const item = found.item;
    expect((await inv.countFind(device(s), s.storeId, id, 'NO-SUCH', { employee: tok(s, 'cashier') })).data.found).toBe(false);
    expect(await code(inv.countEnter(device(s), s.storeId, id, String(item._id), -1, { employee: tok(s, 'cashier') }))).toBe('QTY_INVALID');
    await inv.countEnter(device(s), s.storeId, id, String(item._id), 7, { employee: tok(s, 'cashier') });
    expect(await code(inv.countFinish(device(s), s.storeId, id, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
    await inv.countFinish(device(s), s.storeId, id, { employee: tok(s, 'manager') });
    expect(await stock(s.variantId)).toBe(7);
    const m: any[] = await moves(s.storeId);
    expect(m.map((x) => [x.type, x.qtyDelta, x.unitCostMinor])).toEqual([['adjustment', -3, 100]]);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: { $in: ['stock_count_started', 'stock_count_finished'] } })).toBe(2);
  });
});
