/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import * as schema from '@/database/schema';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosTeamService } from './pos-team.service';
import { PosCashService } from './pos-cash.service';
import { PosInventoryService } from './pos-inventory.service';
import { PosSupplyService } from './pos-supply.service';
import { PosStoreSettingsService } from './pos-store-settings.service';
import { CostVisibilityInterceptor } from './cost-visibility.interceptor';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { InventoryService } from '../inventory/inventory.service';
import { PurchaseOrderSchema } from '../purchase-orders/schemas/purchase-order.schema';
import { SupplierSchema } from '../purchase-orders/schemas/supplier.schema';

/** G5.1 on a real replica-set MongoDB: on-behalf clocking (G5.4), stock by location, orders by cashier / register, products a supplier supplied, staff profile, a photo on a cash movement. */
jest.setTimeout(300_000);
let h: MongoHarness; let r: any; let pos: PosService; let team: PosTeamService; let cash: PosCashService; let inv: PosInventoryService; let supply: PosSupplyService; let st: PosStoreSettingsService; let costs: CostVisibilityInterceptor;
const uploaded: any[] = [];
const fakeUpload: any = {
  uploadPrivateFile: jest.fn(async (file: any, folder: string) => { uploaded.push({ folder, mimetype: file.mimetype }); return { publicId: `${folder}/f${uploaded.length}`, resourceType: 'image', fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype }; }),
  generateExpiringPrivateUrl: jest.fn((publicId: string, _rt: string, ttl: number) => `https://signed.example/${publicId}?ttl=${ttl}`),
  deletePrivateFile: jest.fn(async () => 'ok'),
};
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const c = h.conn;
  Object.assign(h.repos, {
    posAttendanceEventModel: c.model(schema.PosAttendanceEvent.name, schema.PosAttendanceEventSchema),
    posAttendanceStateModel: c.model(schema.PosAttendanceState.name, schema.PosAttendanceStateSchema),
    posRosterShiftModel: c.model(schema.PosRosterShift.name, schema.PosRosterShiftSchema),
    posExpenseModel: c.model(schema.PosExpense.name, schema.PosExpenseSchema), posExpenseEventModel: c.model(schema.PosExpenseEvent.name, schema.PosExpenseEventSchema),
    posCashAttachmentModel: c.model(schema.PosCashAttachment.name, schema.PosCashAttachmentSchema),
    stockAdjustmentModel: c.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: c.model('StockLot', StockLotSchema),
    supplierLedgerEntryModel: c.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
    purchaseOrderModel: c.model('PurchaseOrder', PurchaseOrderSchema), supplierModel: c.model('Supplier', SupplierSchema),
    purchaseReceiptModel: c.model(schema.PurchaseReceipt.name, schema.PurchaseReceiptSchema),
  });
  r = h.repos;
  await Promise.all(['posAttendanceEventModel', 'posAttendanceStateModel', 'posCashAttachmentModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  pos = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, pos);
  team = new PosTeamService(dbs, pos, auth);
  cash = new PosCashService(dbs, pos, auth, fakeUpload);
  inv = new PosInventoryService(dbs, pos, auth, new InventoryService(dbs, { isConnected: false } as any, { notify: jest.fn() } as any, c as any), {} as any);
  supply = new PosSupplyService(dbs, pos, auth, {} as any, {} as any);
  st = new PosStoreSettingsService(dbs, pos, auth);
  costs = new CostVisibilityInterceptor(dbs, auth);
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const sign = (s: Seed, employeeId: string, role: string) => jwt.sign({ employeeId, storeId: s.storeId, role, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const tok = (s: Seed, who: 'manager' | 'cashier') => sign(s, who === 'manager' ? s.managerId : s.cashierId, who);
const device = (s: Seed, emp?: string) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } }, headers: emp ? { 'x-pos-employee-token': emp } : {}, params: { storeId: s.storeId }, query: {} });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' }, headers: {}, params: { storeId: s.storeId }, query: {} });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const rid = () => String(new Types.ObjectId());

async function world() {
  const s = await seedStore(h, { stock: 20, price: 10, baseCurrency: 'USD' });
  // a second cashier (the "member" being clocked by someone else)
  const otherId = new Types.ObjectId();
  await r.employeeModel.collection.insertOne({ _id: otherId, storeId: s.storeId, name: 'Sana (cashier 2)', email: 'sana@e2e.test', role: 'cashier', status: 'active', isDelete: false, pin: 'x' });
  const other = String(otherId);
  return { s, other, C: tok(s, 'cashier'), M: tok(s, 'manager'), O: sign(s, other, 'cashier') };
}

describe('G5.4 · clocking on behalf of another team member', () => {
  const clock = (s: Seed, who: string, body: any, approver?: string) => team.clock(device(s, who), s.storeId, { requestId: rid(), ...body }, { employee: who, approver });

  it('refused without a PIN (POS_APPROVAL_REQUIRED, audited as missing); a cashier\'s own PIN is not the member\'s; nothing is recorded', async () => {
    const w = await world();
    expect(await code(clock(w.s, w.C, { action: 'clock_in', employeeId: w.other }))).toBe('POS_APPROVAL_REQUIRED');
    expect(await code(clock(w.s, w.C, { action: 'clock_in', employeeId: w.other }, w.C))).toBe('POS_APPROVAL_REQUIRED');
    expect(await r.posAttendanceEventModel.countDocuments({ storeId: w.s.storeId, employeeId: w.other })).toBe(0);
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'pos_approval_missing', targetId: w.other })).toBe(2);
  });

  it('approved with the MEMBER\'s PIN: the member is clocked in; the event names actor, subject and approval; the audit row is written in the same transaction', async () => {
    const w = await world();
    const res: any = (await clock(w.s, w.C, { action: 'clock_in', employeeId: w.other }, w.O)).data;
    expect(res.state.clockedIn).toBe(true);
    const ev: any = await r.posAttendanceEventModel.findOne({ storeId: w.s.storeId, employeeId: w.other, type: 'clock_in' }).lean();
    expect([ev.actorId, ev.onBehalf, ev.approvedBy, ev.approval]).toEqual([w.s.cashierId, true, w.other, 'member_pin']);
    const au: any = await r.posAuditLogModel.findOne({ storeId: w.s.storeId, action: 'attendance_clocked_on_behalf' }).lean();
    expect([au.employeeId, au.targetId, au.metadata.actorId, au.metadata.subjectId, au.metadata.approval, au.metadata.eventId]).toEqual([w.s.cashierId, w.other, w.s.cashierId, w.other, 'member_pin', String(ev._id)]);
    // the actor's own attendance is untouched
    expect((await team.me(device(w.s, w.C), w.s.storeId, { employee: w.C })).data.state.clockedIn).toBe(false);
  });

  it('approved with a MANAGER\'s PIN (clock out); self clock-in is unchanged and needs no approver', async () => {
    const w = await world();
    await clock(w.s, w.C, { action: 'clock_in', employeeId: w.other }, w.O);
    const out: any = (await clock(w.s, w.C, { action: 'clock_out', employeeId: w.other }, w.M)).data;
    expect(out.state.clockedIn).toBe(false);
    const ev: any = await r.posAttendanceEventModel.findOne({ storeId: w.s.storeId, employeeId: w.other, type: 'clock_out' }).lean();
    expect([ev.approvedBy, ev.approval]).toEqual([w.s.managerId, 'manager_pin']);
    const self: any = (await clock(w.s, w.C, { action: 'clock_in' })).data; // no approver
    expect(self.state.clockedIn).toBe(true);
    expect(await r.posAttendanceEventModel.countDocuments({ storeId: w.s.storeId, employeeId: w.s.cashierId, onBehalf: true })).toBe(0);
    // employeeId = yourself is plain self clocking
    expect((await clock(w.s, w.C, { action: 'clock_out', employeeId: w.s.cashierId })).data.state.clockedIn).toBe(false);
  });

  it('unknown / deactivated member refused; a replayed request is a no-op even without the approver; an offline (late) event needs a token valid WHEN it happened', async () => {
    const w = await world();
    expect(await code(clock(w.s, w.C, { action: 'clock_in', employeeId: String(new Types.ObjectId()) }, w.M))).toBe('EMPLOYEE_NOT_FOUND');
    const requestId = rid();
    await clock(w.s, w.C, { action: 'clock_in', employeeId: w.other, requestId }, w.O);
    const again: any = (await clock(w.s, w.C, { action: 'clock_in', employeeId: w.other, requestId })).data;
    expect(again.duplicate).toBe(true);
    // late event (2 h ago) with a manager token issued just now: not valid at that time → refused; a token issued before it → accepted
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    expect(await code(clock(w.s, w.C, { action: 'clock_out', employeeId: w.other, deviceAt: twoHoursAgo.toISOString() }, w.M))).toBe('POS_APPROVAL_REQUIRED');
    const older = jwt.sign({ employeeId: w.s.managerId, storeId: w.s.storeId, role: 'manager', type: 'pos_employee', iat: Math.floor(twoHoursAgo.getTime() / 1000) - 60, exp: Math.floor(twoHoursAgo.getTime() / 1000) + 3600 }, 'test-secret');
    const late: any = (await clock(w.s, w.C, { action: 'clock_out', employeeId: w.other, deviceAt: twoHoursAgo.toISOString() }, older)).data;
    expect(late.duplicate).toBe(false);
    await r.employeeModel.updateOne({ _id: w.other }, { $set: { status: 'inactive' } });
    expect(await code(clock(w.s, w.C, { action: 'clock_in', employeeId: w.other }, w.M))).toBe('EMPLOYEE_INACTIVE');
  });
});

describe('G5.1 · small gaps', () => {
  it('stock list for one location: only variants stocked there, bins summed, with that location\'s quantity; "out" = none left there; a bad id is refused', async () => {
    const w = await world();
    const loc = new Types.ObjectId();
    await r.storeLocationModel.collection.insertOne({ _id: loc, storeId: w.s.storeId, name: 'Back store', isDelete: false });
    await r.variantLocationStockModel.collection.insertMany([
      { storeId: w.s.storeId, productId: w.s.productId, variantId: w.s.variantId, locationId: String(loc), binId: null, stock: 3 },
      { storeId: w.s.storeId, productId: w.s.productId, variantId: w.s.variantId, locationId: String(loc), binId: 'b2', stock: 4 },
    ]);
    const at: any = (await inv.stock(device(w.s, w.M), w.s.storeId, { locationId: String(loc) }, { employee: w.M })).data;
    expect([at.items.length, at.items[0].locationStock, at.locationId]).toEqual([1, 7, String(loc)]);
    expect((await inv.stock(device(w.s, w.M), w.s.storeId, { locationId: String(loc), filter: 'out' }, { employee: w.M })).data.items.length).toBe(0);
    expect(await code(inv.stock(device(w.s, w.M), w.s.storeId, { locationId: 'nope' }, { employee: w.M }))).toBe('LOCATION_INVALID');
    // the till reads the locations for the filter (device + PIN session)
    expect((await inv.locations(device(w.s, w.C), w.s.storeId, { employee: w.C })).data.locations).toEqual([{ id: String(loc), name: 'Back store', status: 'active' }]);
    expect(await code(inv.stock(device(w.s, w.M), w.s.storeId, { locationId: String(new Types.ObjectId()) }, { employee: w.M }))).toBe('LOCATION_INVALID');
  });

  it('orders filter by cashier and by register', async () => {
    const w = await world();
    const mk = (employeeId: string, registerId: string, n: number) => ({ storeId: w.s.storeId, saleNumber: `S-${n}`, sessionId: 'x', registerId, employeeId, items: [], total: 1, status: 'completed', deletedAt: null, createdAt: new Date() });
    await r.saleModel.collection.insertMany([mk(w.s.cashierId, 'reg-a', 1), mk(w.s.cashierId, 'reg-b', 2), mk(w.s.managerId, 'reg-a', 3)]);
    const list = async (q: any) => ((await pos.getSales(w.s.sellerId, { storeId: w.s.storeId, ...q })) as any).data;
    const n = (d: any) => (d.sales ?? d.items ?? d).length;
    expect(n(await list({ employeeId: w.s.cashierId }))).toBe(2);
    expect(n(await list({ registerId: 'reg-a' }))).toBe(2);
    expect(n(await list({ employeeId: w.s.cashierId, registerId: 'reg-a' }))).toBe(1);
  });

  it('supplier detail lists the products it supplied (cancelled POs left out); the last unit cost is hidden from a manager with costs hidden', async () => {
    const w = await world();
    const sup = new Types.ObjectId();
    await r.supplierModel.collection.insertOne({ _id: sup, storeId: w.s.storeId, sellerId: w.s.sellerId, name: 'Rice traders', status: 'active', isDelete: false });
    const po = (status: string, qty: number, cost: number, ago: number) => ({ storeId: w.s.storeId, sellerId: w.s.sellerId, supplierId: String(sup), supplierName: 'Rice traders', status, currency: 'USD', poNumber: `PO-${ago}`, createdBy: 'x', createdAt: new Date(Date.now() - ago * 1000),
      items: [{ productId: w.s.productId, variantId: w.s.variantId, name: 'Basmati 5kg', sku: 'RICE5', quantityOrdered: qty, quantityReceived: status === 'received' ? qty : 0, unitCost: cost / 100, unitCostMinor: cost }] });
    await r.purchaseOrderModel.collection.insertMany([po('received', 10, 900, 300), po('ordered', 5, 950, 100), po('cancelled', 99, 1, 50)]);
    const d: any = (await supply.supplier(device(w.s, w.M), w.s.storeId, String(sup), { employee: w.M })).data;
    expect(d.productsSupplied).toEqual([expect.objectContaining({ variantId: w.s.variantId, name: 'Basmati 5kg', orderedQty: 15, receivedQty: 10, orders: 2, lastUnitCostMinor: 950 })]);
    await st.update(owner(w.s) as any, w.s.storeId, { security: { hideCostsFromManagers: true } }, {});
    const hidden: any = await costs.apply(device(w.s, w.M), `/api/pos/supply/suppliers/${w.s.storeId}/${String(sup)}`, { success: true, data: d });
    expect(hidden.data.costsHidden).toBe(true);
    expect(hidden.data.productsSupplied[0].lastUnitCostMinor).toBeUndefined();
    expect(hidden.data.productsSupplied[0].orderedQty).toBe(15);
  });

  it('team members readable from a till (PIN session): names, roles, e-mails — no PINs; needs a PIN session', async () => {
    const w = await world();
    const d: any = (await team.members(device(w.s, w.C), w.s.storeId, { employee: w.C })).data;
    expect(d.members.map((m: any) => m.name)).toContain('Sana (cashier 2)');
    expect(JSON.stringify(d)).not.toMatch(/"pin"/);
    expect(d.members.find((m: any) => m.id === w.other)).toMatchObject({ email: 'sana@e2e.test', role: 'cashier', status: 'active' });
    expect(await code(team.members(device(w.s), w.s.storeId, {}))).toBe('POS_PIN_REQUIRED');
  });

  it('staff profile: last PIN login, clocked in, sales today / 7 / 30 days in minor units; a cashier sees only themself', async () => {
    const w = await world();
    await r.posAuditLogModel.create([{ storeId: w.s.storeId, employeeId: w.s.cashierId, action: 'pin_login', targetId: w.s.cashierId, targetType: 'employee' }]);
    await r.saleModel.collection.insertMany([
      { storeId: w.s.storeId, saleNumber: 'P-1', sessionId: 'x', registerId: 'r', employeeId: w.s.cashierId, items: [], total: 12.5, totalMinor: 1250, status: 'completed', createdAt: new Date() },
      { storeId: w.s.storeId, saleNumber: 'P-2', sessionId: 'x', registerId: 'r', employeeId: w.s.cashierId, items: [], total: 4, totalMinor: 400, status: 'completed', createdAt: new Date(Date.now() - 10 * 86_400_000) },
      { storeId: w.s.storeId, saleNumber: 'P-3', sessionId: 'x', registerId: 'r', employeeId: w.s.cashierId, items: [], total: 9, totalMinor: 900, status: 'voided', createdAt: new Date() },
    ]);
    const p: any = (await team.profile(device(w.s, w.M), w.s.storeId, w.s.cashierId, { employee: w.M })).data;
    expect([p.role, p.lastLoginAt !== null, p.state.clockedIn, p.currency, p.currencyExponent]).toEqual(['cashier', true, false, 'USD', 2]);
    expect([p.sales.today, p.sales.last7Days, p.sales.last30Days]).toEqual([{ sales: 1, totalMinor: 1250 }, { sales: 1, totalMinor: 1250 }, { sales: 2, totalMinor: 1650 }]);
    expect((await team.profile(device(w.s, w.C), w.s.storeId, w.s.cashierId, { employee: w.C })).data.employeeId).toBe(w.s.cashierId);
    expect(await code(team.profile(device(w.s, w.C), w.s.storeId, w.s.managerId, { employee: w.C }))).toBe('POS_ACTION_FORBIDDEN');
  });

  it('a photo on a cash movement: stored privately (append-only row + audit, one transaction), shown in the daybook, an expiring link; another cashier is refused', async () => {
    const w = await world();
    const sid = new Types.ObjectId();
    await r.registerSessionModel.collection.insertOne({ _id: sid, storeId: w.s.storeId, registerId: w.s.registerId, employeeId: w.s.cashierId, status: 'open', openedAt: new Date(Date.now() - 3_600_000), openingCash: 100, openingCashMinor: 10000, cashSales: 0, cashSalesMinor: 0, totalSales: 0, totalTransactions: 0 });
    const requestId = rid();
    await cash.move(device(w.s, w.C), w.s.storeId, { type: 'cash_out', category: 'petty', amountMinor: 500, sessionId: String(sid), requestId }, { employee: w.C });
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const file = { buffer: PNG, size: PNG.length, originalname: 'r.png', mimetype: 'image/png' } as any;
    expect(await code(cash.movementReceiptUpload(device(w.s, w.O), w.s.storeId, requestId, file, { employee: w.O }))).toBe('POS_ACTION_FORBIDDEN');
    const up: any = (await cash.movementReceiptUpload(device(w.s, w.C), w.s.storeId, requestId, file, { employee: w.C })).data;
    expect([up.hasReceipt, up.receiptMimeType]).toEqual([true, 'image/png']);
    expect(uploaded.at(-1).folder).toBe(`private/cash-receipts/${w.s.storeId}`);
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'cash_movement_receipt_attached' })).toBe(1);
    const book: any = (await cash.daybook(device(w.s, w.M), w.s.storeId, { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() }, { employee: w.M })).data;
    const line = JSON.stringify(book).includes('"hasReceipt":true');
    expect(line).toBe(true);
    const link: any = (await cash.movementReceiptLink(device(w.s, w.M), w.s.storeId, requestId, { employee: w.M })).data;
    expect([link.url.startsWith('https://signed.example/'), link.expiresInSeconds]).toEqual([true, 300]);
    expect(await code(cash.movementReceiptLink(device(w.s, w.M), w.s.storeId, rid(), { employee: w.M }))).toBe('MOVEMENT_NOT_FOUND');
    const att: any = await r.posCashAttachmentModel.findOne({ requestId }).lean();
    await expect(r.posCashAttachmentModel.updateOne({ _id: att._id }, { $set: { employeeId: 'x' } })).rejects.toThrow(/append-only/);
  });
});
