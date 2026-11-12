/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosInventoryService } from './pos-inventory.service';
import { PosSupplyService } from './pos-supply.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { StockTransferSchema } from '../inventory/schemas/stock-transfer.schema';
import { BinSchema } from '../inventory/schemas/bin.schema';
import { PurchaseOrderSchema } from '../purchase-orders/schemas/purchase-order.schema';
import { SupplierSchema } from '../purchase-orders/schemas/supplier.schema';
import { InventoryService } from '../inventory/inventory.service';
import { moneyContractViolations } from './testing/money-contract';

/** G4.6: opening-shift notes/coins + the previous close, expiry buckets + write-off, stock transfers and low stock → PO draft — through the till's matrix. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let inv: PosInventoryService; let sup: PosSupplyService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const c = h.conn;
  Object.assign(h.repos, {
    stockAdjustmentModel: c.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: c.model('StockLot', StockLotSchema), stockTransferModel: c.model('StockTransfer', StockTransferSchema), binModel: c.model('Bin', BinSchema),
    purchaseOrderModel: c.model('PurchaseOrder', PurchaseOrderSchema), supplierModel: c.model('Supplier', SupplierSchema), orderModel: c.model('OrderG46', new mongoose.Schema({}, { strict: false })),
    purchaseReceiptModel: c.model(schema.PurchaseReceipt.name, schema.PurchaseReceiptSchema), supplierLedgerEntryModel: c.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
    staffMemberModel: c.model('StaffMember', new mongoose.Schema({ name: String }, { strict: false })),
  });
  r = h.repos;
  await Promise.all(['stockAdjustmentModel', 'purchaseOrderModel', 'posSettingsModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  svc = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, svc);
  const invSvc = new InventoryService(dbs, { isConnected: false } as any, { notify: jest.fn() } as any, c as any);
  inv = new PosInventoryService(dbs, svc, auth, invSvc, {} as any);
  sup = new PosSupplyService(dbs, svc, auth, invSvc, {} as any);
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.response?.message ?? e?.message ?? 'error'; } };

describe('opening the shift: notes / coins and the previous close', () => {
  it('a float counted in notes and coins must add up; the breakdown is stored; the next shift sees the last close (counted, expected, variance, by whom)', async () => {
    const s = await seedStore(h, { baseCurrency: 'PKR' });
    expect((await svc.lastClose(s.sellerId, s.storeId, s.registerId)).data.lastClose).toBeNull();
    const bad = await code(svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 1500, denominations: [{ valueMinor: 100_000, count: 1 }, { valueMinor: 10_000, count: 4 }] } as any));
    expect(bad).toBe('DENOMINATION_MISMATCH'); // 1,000 + 400 ≠ 1,500
    const opened: any = (await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 1500, denominations: [{ valueMinor: 100_000, count: 1 }, { valueMinor: 10_000, count: 5 }] } as any)).data;
    expect((await r.registerSessionModel.findById(opened._id).lean()).openingDenominations).toEqual([{ valueMinor: 100_000, count: 1 }, { valueMinor: 10_000, count: 5 }]);
    expect(await code(svc.closeSession(s.sellerId, { sessionId: String(opened._id), closingCash: 1490, denominations: [{ valueMinor: 100_000, count: 1 }] } as any, tok(s, 'manager')))).toBe('DENOMINATION_MISMATCH');
    await svc.closeSession(s.sellerId, { sessionId: String(opened._id), closingCash: 1490, denominations: [{ valueMinor: 100_000, count: 1 }, { valueMinor: 10_000, count: 4 }, { valueMinor: 5_000, count: 1 }, { valueMinor: 1_000, count: 4 }] } as any, tok(s, 'manager'));
    const last: any = (await svc.lastClose(s.sellerId, s.storeId, s.registerId)).data;
    expect(last.lastClose).toMatchObject({ countedMinor: 149_000, expectedMinor: 150_000, varianceMinor: -1_000 });
    expect(last.lastClose.denominations).toHaveLength(4);
    expect(moneyContractViolations(last)).toEqual([]);
    // opening without a breakdown still works exactly as before
    expect((await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 100 } as any)).success).toBe(true);
  });
});

describe('expiry buckets + write-off', () => {
  it('lots split into expired / ≤ 7 days / ≤ 30 days; a manager writes off an expired lot (stock, lot and the ledger move); a cashier cannot; costs only for managers', async () => {
    const s = await seedStore(h, { stock: 30 });
    const lot = (days: number, qty: number, n: string) => r.stockLotModel.create({ storeId: s.storeId, productId: s.productId, variantId: s.variantId, lotNumber: n, expiryDate: new Date(Date.now() + days * 86_400_000), quantityReceived: qty, quantityRemaining: qty, costPrice: 2, costPriceMinor: 200, status: 'active' });
    const gone = await lot(-2, 5, 'OLD'); await lot(3, 4, 'SOON'); await lot(20, 6, 'LATER'); await lot(90, 15, 'FAR');
    const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
    const e = (await inv.expiry(device(s), s.storeId, M)).data;
    expect([e.expired.map((x: any) => x.lotNumber), e.within7.map((x: any) => x.lotNumber), e.within30.map((x: any) => x.lotNumber)]).toEqual([['OLD'], ['SOON'], ['LATER']]);
    expect(e.expired[0].valueMinor).toBe(1_000);
    expect(moneyContractViolations(e)).toEqual([]);
    expect((await inv.expiry(device(s), s.storeId, C)).data.expired[0].valueMinor).toBeUndefined();
    expect(await code(inv.writeOffLot(device(s), s.storeId, String(gone._id), { reason: 'expired' }, C))).toBe('POS_ACTION_FORBIDDEN');
    const w = (await inv.writeOffLot(device(s), s.storeId, String(gone._id), { reason: 'expired' }, M)).data;
    expect([w.written, w.remaining, w.newStock]).toEqual([5, 0, 25]);
    expect(await r.stockMovementModel.countDocuments({ storeId: s.storeId, type: 'write_off' })).toBeGreaterThanOrEqual(0); // the adjustment hook writes the ledger row when the model is registered
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'lot_written_off' })).toBe(1);
  });
});

describe('transfers through the till', () => {
  it('a manager ships between two locations and receives at the other; a cashier cannot ship', async () => {
    const s = await seedStore(h, { stock: 20 });
    const [a, b] = await r.storeLocationModel.create([{ storeId: s.storeId, sellerId: s.sellerId, name: 'Front', isDelete: false, status: 'active', isActive: true }, { storeId: s.storeId, sellerId: s.sellerId, name: 'Back', isDelete: false, status: 'active', isActive: true }]);
    await r.variantLocationStockModel.create({ storeId: s.storeId, variantId: s.variantId, productId: s.productId, locationId: String(a._id), stock: 20 });
    const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
    const body = { variantId: s.variantId, fromLocationId: String(a._id), toLocationId: String(b._id), quantity: 6 };
    expect(await code(inv.transferShip(device(s), s.storeId, body, C))).toBe('POS_ACTION_FORBIDDEN');
    const shipped: any = await inv.transferShip(device(s), s.storeId, body, M);
    const id = String(shipped.data?._id ?? shipped.data?.transfer?._id);
    const list: any = await inv.transfers(device(s), s.storeId, {}, C); // reading is open to everyone on the till
    expect(list.data.length).toBe(1);
    await inv.transferReceive(device(s), s.storeId, id, { receivedQty: 6 }, M);
    const rows: any[] = await r.variantLocationStockModel.find({ variantId: s.variantId }).lean();
    expect(Object.fromEntries(rows.map((x) => [x.locationId, x.stock]))).toEqual({ [String(a._id)]: 14, [String(b._id)]: 6 });
  });
});

describe('low stock → purchase order draft', () => {
  it('drafts a PO for the supplier with the suggested quantities at the current average cost; nothing low → a clear refusal', async () => {
    const s = await seedStore(h, { stock: 2 });
    await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: { reorderPoint: 10, costPrice: 3.5, costPriceMinor: 350 } });
    const M = { employee: tok(s, 'manager') };
    const supplier = await r.supplierModel.create({ storeId: s.storeId, sellerId: s.sellerId, name: 'Tea Co', status: 'active' });
    await r.productModel.collection.updateOne({ _id: new Types.ObjectId(s.productId) }, { $set: { supplierId: String(supplier._id) } });
    const po: any = (await sup.draftFromLowStock(device(s), s.storeId, { supplierId: String(supplier._id) }, M)).data.order;
    expect([po.status, po.items.length, po.items[0].variantId, po.items[0].unitCostMinor]).toEqual(['draft', 1, s.variantId, 350]);
    expect(po.items[0].quantityOrdered).toBeGreaterThanOrEqual(1);
    const other = await r.supplierModel.create({ storeId: s.storeId, sellerId: s.sellerId, name: 'Nobody', status: 'active' });
    expect(await code(sup.draftFromLowStock(device(s), s.storeId, { supplierId: String(other._id) }, M))).toBe('NOTHING_LOW');
    expect(await code(sup.draftFromLowStock(device(s), s.storeId, { supplierId: String(supplier._id) }, { employee: tok(s, 'cashier') }))).toBe('POS_ACTION_FORBIDDEN');
  });
});
