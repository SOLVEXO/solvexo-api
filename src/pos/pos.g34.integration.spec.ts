/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosSupplyService } from './pos-supply.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import * as schema from '@/database/schema';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { StockUnitSchema } from '../inventory/schemas/stock-unit.schema';
import { PurchaseOrderSchema } from '../purchase-orders/schemas/purchase-order.schema';
import { SupplierReturnSchema } from '../purchase-orders/schemas/supplier-return.schema';
import { SupplierSchema } from '../purchase-orders/schemas/supplier.schema';
import { ApprovalRequestSchema } from '../staff/schemas/approval-request.schema';
import { InventoryService } from '../inventory/inventory.service';
import { SupplierReturnsService } from '../purchase-orders/supplier-returns.service';
import { moneyContractViolations } from './testing/money-contract';

/** G3.4 on a real replica-set MongoDB: purchase-order lifecycle + approvals, partial receipts, weighted-average cost at exponent 0 / 2 / 3, lots → FEFO, supplier returns + credit, payables, cash payments. */
jest.setTimeout(300_000);
let h: MongoHarness; let svc: PosService; let sup: PosSupplyService; let r: any;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const conn = h.conn;
  Object.assign(h.repos, {
    stockAdjustmentModel: conn.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: conn.model('StockLot', StockLotSchema), stockUnitModel: conn.model('StockUnit', StockUnitSchema),
    purchaseOrderModel: conn.model('PurchaseOrder', PurchaseOrderSchema), supplierReturnModel: conn.model('SupplierReturn', SupplierReturnSchema), supplierModel: conn.model('Supplier', SupplierSchema),
    purchaseReceiptModel: conn.model(schema.PurchaseReceipt.name, schema.PurchaseReceiptSchema), supplierLedgerEntryModel: conn.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
    approvalRequestModel: conn.model('ApprovalRequest', ApprovalRequestSchema), staffMemberModel: conn.model('StaffMember', new mongoose.Schema({ name: String }, { strict: false })),
  });
  r = h.repos;
  await Promise.all(['stockAdjustmentModel', 'purchaseOrderModel', 'purchaseReceiptModel', 'supplierLedgerEntryModel', 'supplierReturnModel', 'stockLotModel', 'posSettingsModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  const activity: any = { log: jest.fn(async () => undefined) };
  svc = new PosService(dbs, activity, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const invSvc = new InventoryService(dbs, { isConnected: false } as any, { notify: jest.fn() } as any, conn as any);
  sup = new PosSupplyService(dbs, svc, new PosAuthorizer(dbs, svc), invSvc, new SupplierReturnsService(dbs, activity, invSvc, conn as any));
});
afterAll(async () => { await h?.stop(); });

type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };
const rid = () => String(new Types.ObjectId());
const day = (n: number) => new Date(Date.now() + n * 86_400_000);

/** a store in `currency` with a variant at `stock` units and (optionally) a known average cost (minor units), a supplier and an open shift */
async function world(o: { currency?: string; stock?: number; costMinor?: number; trackLots?: boolean } = {}) {
  const s = await seedStore(h, { stock: o.stock ?? 0, price: 10, baseCurrency: o.currency ?? 'USD' });
  const exp = ({ JPY: 0, KWD: 3 } as any)[o.currency ?? 'USD'] ?? 2;
  const set: any = {};
  if (o.costMinor !== undefined) { set.costPriceMinor = o.costMinor; set.costPrice = o.costMinor / 10 ** exp; }
  if (o.trackLots) set.trackLots = true;
  if (Object.keys(set).length) await r.productVariantModel.collection.updateOne({ _id: new Types.ObjectId(s.variantId) }, { $set: set });
  const sid = String(new Types.ObjectId());
  await r.registerSessionModel.collection.insertOne({ _id: new Types.ObjectId(sid), storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date(), openingCash: 50, cashSales: 0, totalSales: 0, totalTransactions: 0 });
  const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
  const supplier = (await sup.createSupplier(device(s), s.storeId, { name: 'Acme Wholesale', ntn: '1234567-8', paymentTerms: 'Net 30' }, M)).data.supplier;
  const mkPo = async (qty: number, unitCostMinor: number, extra: any = {}) => (await sup.createOrder(device(s), s.storeId, { supplierId: supplier.id, items: [{ variantId: s.variantId, quantityOrdered: qty, unitCostMinor }], ...extra }, M)).data.order;
  const approved = async (qty: number, unitCostMinor: number, extra: any = {}) => { const po = await mkPo(qty, unitCostMinor, extra); return (await sup.approveOrder(device(s), s.storeId, po.id, M)).data.order; };
  const recv = async (po: any, qtyGood: number, extra: any = {}, who: any = M, lineExtra: any = {}) => (await sup.receive(device(s), s.storeId, { purchaseOrderId: po.id, requestId: rid(), lines: [{ poItemId: po.items[0].id, qtyGood, ...lineExtra }], ...extra }, who)).data;
  const variant = async () => r.productVariantModel.findById(s.variantId).lean();
  const bal = async () => (await sup.ledger(device(s), s.storeId, supplier.id, M)).data;
  const shift = async () => r.registerSessionModel.collection.findOne({ _id: new Types.ObjectId(sid) });
  return { s, sid, exp, M, C, supplier, mkPo, approved, recv, variant, bal, shift };
}

describe('purchase-order lifecycle and approvals', () => {
  it('draft → approved → sent; numbers are a per-store sequence; edits reset to draft; cancel only before receiving', async () => {
    const w = await world();
    const po1 = await w.mkPo(10, 500);
    const po2 = await w.mkPo(5, 700);
    expect([po1.poNumber, po2.poNumber, po1.status]).toEqual(['PO-000001', 'PO-000002', 'draft']);
    expect(po1.totalMinor).toBe(5000);
    const other = await world(); // another store has its own sequence
    expect((await other.mkPo(1, 100)).poNumber).toBe('PO-000001');

    expect(await code(sup.sendOrder(device(w.s), w.s.storeId, po1.id, w.M))).toBe('PO_NOT_APPROVED'); // approve first
    expect(await code(sup.receive(device(w.s), w.s.storeId, { purchaseOrderId: po1.id, lines: [{ poItemId: po1.items[0].id, qtyGood: 1 }] }, w.M))).toBe('PO_NOT_RECEIVABLE'); // a draft cannot be received
    const ap = (await sup.approveOrder(device(w.s), w.s.storeId, po1.id, w.M)).data.order;
    expect([ap.status, ap.approvedBy]).toEqual(['approved', w.s.managerId]);
    // editing an approved PO is allowed before receiving, and sends it back to draft for a new approval
    const ed = (await sup.updateOrder(device(w.s), w.s.storeId, po1.id, { items: [{ variantId: w.s.variantId, quantityOrdered: 20, unitCostMinor: 450 }] }, w.M)).data.order;
    expect([ed.status, ed.approvedBy, ed.totalMinor]).toEqual(['draft', null, 9000]);
    await sup.approveOrder(device(w.s), w.s.storeId, po1.id, w.M);
    const sent = (await sup.sendOrder(device(w.s), w.s.storeId, po1.id, w.M)).data.order;
    expect(sent.status).toBe('sent');
    expect((await sup.cancelOrder(device(w.s), w.s.storeId, po2.id, w.M)).data.order.status).toBe('cancelled');
    expect(await code(sup.receive(device(w.s), w.s.storeId, { purchaseOrderId: po2.id, lines: [{ poItemId: po2.items[0].id, qtyGood: 1 }] }, w.M))).toBe('PO_NOT_RECEIVABLE');

    await w.recv(sent, 5); // receiving started → no more edits, no cancel
    expect(await code(sup.updateOrder(device(w.s), w.s.storeId, po1.id, { notes: 'x' }, w.M))).toBe('PO_NOT_EDITABLE');
    expect(await code(sup.cancelOrder(device(w.s), w.s.storeId, po1.id, w.M))).toBe('PO_NOT_CANCELLABLE');
    expect((await sup.closeShort(device(w.s), w.s.storeId, po1.id, w.M)).data.order.status).toBe('closed_short');
  });

  it('approval follows the permission matrix and the per-store limit: a manager alone up to the limit; above it only the owner; a cashier never', async () => {
    const w = await world(); // USD → default limit 1000.00 = 100 000 minor
    const small = await w.mkPo(10, 1000); // 100.00
    const big = await w.mkPo(1000, 1000); // 10 000.00
    expect(await code(sup.approveOrder(device(w.s), w.s.storeId, small.id, w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(sup.approveOrder(device(w.s), w.s.storeId, big.id, w.M))).toBe('POS_OWNER_REQUIRED');
    expect((await sup.approveOrder(owner(w.s), w.s.storeId, big.id, {})).data.order.status).toBe('approved'); // the owner's own session
    expect((await sup.approveOrder(device(w.s), w.s.storeId, small.id, w.M)).data.order.status).toBe('approved');
    // a store-specific limit moves the line
    await r.posSettingsModel.updateOne({ storeId: w.s.storeId }, { $set: { approvalLimits: { purchaseOrderMinor: 500 } } });
    const mid = await w.mkPo(10, 1000);
    expect(await code(sup.approveOrder(device(w.s), w.s.storeId, mid.id, w.M))).toBe('POS_OWNER_REQUIRED');
    // the approval is in the audit trail
    expect(await r.posAuditLogModel.countDocuments({ storeId: w.s.storeId, action: 'po_approved' })).toBe(2);
  });

  it('a cashier sees only receivable POs and NO costs; cost / payables / payment routes refuse them', async () => {
    const w = await world();
    const po = await w.approved(10, 1000);
    await w.mkPo(3, 100); // a draft: invisible to a cashier
    const list = (await sup.orders(device(w.s), w.s.storeId, {}, w.C)).data.orders;
    expect(list.map((x: any) => x.id)).toEqual([po.id]);
    expect(JSON.stringify(list)).not.toMatch(/Minor/);
    const one = (await sup.order(device(w.s), w.s.storeId, po.id, w.C)).data;
    expect(JSON.stringify(one)).not.toMatch(/CostMinor|totalMinor|lineTotalMinor/);
    for (const call of [() => sup.payables(device(w.s), w.s.storeId, w.C), () => sup.receipts(device(w.s), w.s.storeId, {}, w.C), () => sup.suppliers(device(w.s), w.s.storeId, w.C), () => sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor: 1, method: 'bank', requestId: rid() }, w.C)]) {
      expect(await code(call())).toBe('POS_ACTION_FORBIDDEN');
    }
  });
});

describe('receiving: partial receipts, caps, lots, bills', () => {
  it('a cashier receives against an approved PO at the PO cost (stock, bill and a stock-ledger movement), partially, then the rest → received; nothing beyond the ordered quantity', async () => {
    const w = await world({ stock: 0 });
    const po = await w.approved(10, 250); // 2.50 each
    expect(await code(sup.receive(device(w.s), w.s.storeId, { purchaseOrderId: po.id, lines: [{ poItemId: po.items[0].id, qtyGood: 1, unitCostMinor: 1 }] }, w.C))).toBe('COST_NOT_ALLOWED');
    const a = await w.recv(po, 4, {}, w.C);
    expect(a.order.status).toBe('partially_received');
    expect(JSON.stringify(a.receipt)).not.toMatch(/Minor/); // costs hidden from the cashier
    expect((await w.variant()).stock).toBe(4);
    const mv: any[] = await r.stockMovementModel.find({ storeId: w.s.storeId, type: 'receive' }).lean();
    expect([mv.length, mv[0].qtyDelta, mv[0].unitCostMinor]).toEqual([1, 4, 250]);
    expect((await w.bal()).aging.balanceMinor).toBe(1000); // the bill for 4 × 2.50
    expect(await code(sup.receive(device(w.s), w.s.storeId, { purchaseOrderId: po.id, requestId: rid(), lines: [{ poItemId: po.items[0].id, qtyGood: 7 }] }, w.C))).toBe('OVER_RECEIPT');
    expect((await w.variant()).stock).toBe(4); // the refused receipt changed nothing
    const b = await w.recv(po, 4, {}, w.C, { qtyDamaged: 2 }); // 4 good + 2 damaged finish the order
    expect(b.order.status).toBe('received');
    const v = await w.variant();
    expect([v.stock, v.damagedStock]).toEqual([10, 2]);
    expect((await w.bal()).aging.balanceMinor).toBe(2500); // the damaged units are billed too and come back as a credit
    expect(await code(sup.receive(device(w.s), w.s.storeId, { purchaseOrderId: po.id, lines: [{ poItemId: po.items[0].id, qtyGood: 1 }] }, w.M))).toBe('PO_NOT_RECEIVABLE');
  });

  it('a retried receipt (same requestId) is returned, not applied twice', async () => {
    const w = await world();
    const po = await w.approved(10, 100);
    const id = rid();
    const a = await w.recv(po, 3, { requestId: id });
    const b = await w.recv(po, 3, { requestId: id });
    expect([a.duplicate, b.duplicate, b.receipt.id]).toEqual([false, true, a.receipt.id]);
    expect((await w.variant()).stock).toBe(3);
    expect(await r.supplierLedgerEntryModel.countDocuments({ storeId: w.s.storeId, type: 'bill' })).toBe(1);
  });

  it('two tills receiving the same PO line at the same moment: the cap holds (no over-receipt), stock and bill match exactly what was accepted', async () => {
    for (let round = 0; round < 6; round++) {
      const w = await world();
      const po = await w.approved(10, 100);
      const res = await Promise.allSettled([w.recv(po, 6, {}, w.C), w.recv(po, 6, {}, w.M), w.recv(po, 5, {}, w.C)]);
      const ok = res.filter((x) => x.status === 'fulfilled').length;
      const received = (await r.purchaseOrderModel.findById(po.id).lean()).items[0].quantityReceived;
      expect(received).toBeLessThanOrEqual(10);
      expect((await w.variant()).stock).toBe(received);
      expect((await w.bal()).aging.balanceMinor).toBe(received * 100);
      expect(await r.purchaseReceiptModel.countDocuments({ storeId: w.s.storeId })).toBe(ok);
      for (const x of res) if (x.status === 'rejected') expect((x.reason as any)?.response?.code).toBe('OVER_RECEIPT');
    }
  });

  it('a receipt without a PO is manager-only, needs a supplier and unit costs, and bills the supplier; the optional supplier invoice number / date are stored', async () => {
    const w = await world({ stock: 0 });
    const line = { variantId: w.s.variantId, qtyGood: 5, unitCostMinor: 300 };
    expect(await code(sup.receive(device(w.s), w.s.storeId, { supplierId: w.supplier.id, lines: [line] }, w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(sup.receive(device(w.s), w.s.storeId, { lines: [line] }, w.M))).toBe('SUPPLIER_REQUIRED');
    expect(await code(sup.receive(device(w.s), w.s.storeId, { supplierId: w.supplier.id, lines: [{ variantId: w.s.variantId, qtyGood: 5 }] }, w.M))).toBe('INVALID_AMOUNT');
    const out = (await sup.receive(device(w.s), w.s.storeId, { supplierId: w.supplier.id, requestId: rid(), supplierInvoiceNumber: 'INV-77', supplierInvoiceDate: '2026-10-01', lines: [line] }, w.M)).data;
    expect([out.receipt.purchaseOrderId, out.receipt.totalMinor, out.receipt.supplierInvoiceNumber, out.receipt.receiptNumber]).toEqual([null, 1500, 'INV-77', 'GRN-000001']);
    expect((await w.variant()).stock).toBe(5);
    const entry = (await w.bal()).entries[0];
    expect([entry.type, entry.amountMinor, entry.supplierInvoiceNumber]).toEqual(['bill', 1500, 'INV-77']);
  });

  it('a lot-tracked product needs a lot number; the lot carries expiry and cost; selling then takes the EARLIEST expiry first (FEFO)', async () => {
    const w = await world({ trackLots: true });
    const po = await w.approved(20, 400);
    expect(await code(sup.receive(device(w.s), w.s.storeId, { purchaseOrderId: po.id, lines: [{ poItemId: po.items[0].id, qtyGood: 5 }] }, w.M))).toBe('LOT_REQUIRED');
    expect((await sup.order(device(w.s), w.s.storeId, po.id, w.C)).data.order.items[0].trackLots).toBe(true); // the till can ask for the lot up front
    await w.recv(po, 8, {}, w.M, { lotNumber: 'L-LATE', expiryDate: day(90).toISOString() });
    await w.recv(po, 6, {}, w.M, { lotNumber: 'L-SOON', expiryDate: day(20).toISOString() });
    const lots: any[] = await r.stockLotModel.find({ storeId: w.s.storeId }).sort({ expiryDate: 1 }).lean();
    expect(lots.map((l) => [l.lotNumber, l.quantityRemaining, l.costPriceMinor])).toEqual([['L-SOON', 6, 400], ['L-LATE', 8, 400]]);
    expect(lots[0].receiptId).toEqual(expect.any(String));
    await svc.createSale(w.s.sellerId, { storeId: w.s.storeId, sessionId: w.sid, registerId: w.s.registerId, employeeId: w.s.cashierId, items: [{ productId: w.s.productId, variantId: w.s.variantId, qty: 4 }], paymentMethod: 'cash' } as any, tok(w.s, 'manager'));
    const after: any[] = await r.stockLotModel.find({ storeId: w.s.storeId }).sort({ expiryDate: 1 }).lean();
    expect(after.map((l) => [l.lotNumber, l.quantityRemaining])).toEqual([['L-SOON', 2], ['L-LATE', 8]]);
  });
});

describe('weighted-average cost (D5) in minor units at exponent 0 / 2 / 3', () => {
  const cases: Array<[string, number, number, number, number, number, number]> = [
    // currency, existing stock, existing avg (minor), qty received, unit cost (minor), expected avg (minor), expected exponent
    ['USD', 10, 100, 10, 200, 150, 2],      // 1.00 and 2.00 → 1.50
    ['JPY', 10, 100, 5, 130, 110, 0],       // (1000 + 650) / 15 = 110
    ['KWD', 7, 1250, 3, 1700, 1385, 3],     // (8750 + 5100) / 10 = 1385 (1.385)
  ];
  it.each(cases)('%s: %i units at %i + %i at %i → %i', async (currency, onHand, avg, qty, unit, expected, exp) => {
    const w = await world({ currency, stock: onHand, costMinor: avg });
    expect(w.exp).toBe(exp);
    const po = await w.approved(qty, unit);
    await w.recv(po, qty);
    const v = await w.variant();
    expect([v.costPriceMinor, v.costPrice, v.stock]).toEqual([expected, expected / 10 ** exp, onHand + qty]);
  });
  it('rounds to a whole minor unit (never a fraction), a receipt AFTER SALES uses the stock that is really left, and the first ever receipt sets the cost', async () => {
    const w = await world({ currency: 'KWD', stock: 10, costMinor: 1000 });
    await svc.createSale(w.s.sellerId, { storeId: w.s.storeId, sessionId: w.sid, registerId: w.s.registerId, employeeId: w.s.cashierId, items: [{ productId: w.s.productId, variantId: w.s.variantId, qty: 7 }], paymentMethod: 'cash' } as any, tok(w.s, 'manager'));
    expect((await w.variant()).stock).toBe(3);
    const po = await w.approved(4, 1337);
    await w.recv(po, 4);
    const v = await w.variant();
    expect(v.costPriceMinor).toBe(Math.round((3 * 1000 + 4 * 1337) / 7)); // 1193
    expect(v.costPriceMinor).toBe(1193);
    const fresh = await world({ currency: 'JPY', stock: 0 }); // no cost yet
    const p2 = await fresh.approved(5, 77);
    await fresh.recv(p2, 5);
    expect((await fresh.variant()).costPriceMinor).toBe(77);
    // a different-cost second receipt re-weights again on the NEW stock
    const p3 = await fresh.approved(5, 100);
    await fresh.recv(p3, 5);
    expect((await fresh.variant()).costPriceMinor).toBe(89); // (5 × 77 + 5 × 100) / 10 = 88.5 → 89
  });
  it('the stock ledger still reconciles: opening + Σ movements = stock after receipts, sales, a supplier return', async () => {
    const w = await world({ stock: 20, costMinor: 100 });
    const po = await w.approved(10, 120);
    await w.recv(po, 8, {}, w.M, { qtyDamaged: 2 });
    await svc.createSale(w.s.sellerId, { storeId: w.s.storeId, sessionId: w.sid, registerId: w.s.registerId, employeeId: w.s.cashierId, items: [{ productId: w.s.productId, variantId: w.s.variantId, qty: 5 }], paymentMethod: 'cash' } as any, tok(w.s, 'manager'));
    await sup.createReturn(device(w.s), w.s.storeId, { supplierId: w.supplier.id, purchaseOrderId: po.id, items: [{ variantId: w.s.variantId, quantity: 2, fromDamaged: true }], reason: 'damaged' }, w.M);
    const v = await w.variant();
    const sum = (await r.stockMovementModel.aggregate([{ $match: { storeId: w.s.storeId } }, { $group: { _id: null, q: { $sum: '$qtyDelta' } } }]))[0].q;
    expect(20 + sum).toBe(v.stock);
  });
});

describe('supplier returns, credit and payables', () => {
  it('a return against a receipt takes stock from the RIGHT lot, never more than that receipt brought in, and writes a supplier credit (minor) in the same transaction', async () => {
    const w = await world({ trackLots: true });
    const po = await w.approved(20, 500);
    const r1 = (await w.recv(po, 6, {}, w.M, { lotNumber: 'A', expiryDate: day(60).toISOString() })).receipt;
    const r2 = (await w.recv(po, 5, {}, w.M, { lotNumber: 'B', expiryDate: day(30).toISOString() })).receipt;
    const lotA = r1.lines[0].lotId;
    expect((await w.bal()).aging.balanceMinor).toBe(11 * 500);
    expect(await code(sup.createReturn(device(w.s), w.s.storeId, { receiptId: r1.id, items: [{ variantId: w.s.variantId, quantity: 7, lotId: lotA }] }, w.M))).toBe('EXCEEDS_RECEIPT');
    expect(await code(sup.createReturn(device(w.s), w.s.storeId, { receiptId: r1.id, items: [{ variantId: w.s.variantId, quantity: 1, lotId: r2.lines[0].lotId }] }, w.M))).toBe('LOT_NOT_ON_RECEIPT');
    const out = (await sup.createReturn(device(w.s), w.s.storeId, { receiptId: r1.id, requestId: rid(), reason: 'defective', items: [{ variantId: w.s.variantId, quantity: 2, lotId: lotA }] }, w.M)).data;
    expect([out.return.creditMinor, out.return.receiptId]).toEqual([1000, r1.id]);
    const lots: any[] = await r.stockLotModel.find({ storeId: w.s.storeId }).sort({ lotNumber: 1 }).lean();
    expect(lots.map((l) => [l.lotNumber, l.quantityRemaining])).toEqual([['A', 4], ['B', 5]]);
    expect((await w.variant()).stock).toBe(9);
    const mv: any[] = await r.stockMovementModel.find({ storeId: w.s.storeId, type: 'supplier_return' }).lean();
    expect([mv.length, mv[0].qtyDelta]).toEqual([1, -2]);
    const led = await w.bal();
    expect(led.aging.balanceMinor).toBe(11 * 500 - 1000);
    expect(led.entries[0]).toMatchObject({ type: 'credit', amountMinor: -1000, refType: 'supplier_return' });
    // 4 of A's 6 are still returnable on that receipt, no more
    expect(await code(sup.createReturn(device(w.s), w.s.storeId, { receiptId: r1.id, items: [{ variantId: w.s.variantId, quantity: 5, lotId: lotA }] }, w.M))).toBe('EXCEEDS_RECEIPT');
    expect(await code(sup.createReturn(device(w.s), w.s.storeId, { receiptId: r1.id, items: [{ variantId: w.s.variantId, quantity: 1 }] }, w.C))).toBe('POS_ACTION_FORBIDDEN');
  });

  it('a retried return (same requestId) neither removes stock nor credits twice', async () => {
    const w = await world();
    const po = await w.approved(10, 100);
    const rc = (await w.recv(po, 10)).receipt;
    const id = rid();
    const body = { receiptId: rc.id, requestId: id, items: [{ variantId: w.s.variantId, quantity: 3 }] };
    const a = (await sup.createReturn(device(w.s), w.s.storeId, body, w.M)).data;
    const b = (await sup.createReturn(device(w.s), w.s.storeId, body, w.M)).data;
    expect([a.duplicate, b.duplicate]).toEqual([false, true]);
    expect((await w.variant()).stock).toBe(7);
    expect(await r.supplierLedgerEntryModel.countDocuments({ storeId: w.s.storeId, type: 'credit' })).toBe(1);
  });

  it('the supplier ledger is append-only and the balance is the sum of its rows', async () => {
    const w = await world();
    await w.recv(await w.approved(10, 100), 10);
    const e: any = await r.supplierLedgerEntryModel.findOne({ storeId: w.s.storeId });
    await expect(r.supplierLedgerEntryModel.updateOne({ _id: e._id }, { $set: { amountMinor: 1 } })).rejects.toThrow(/append-only/);
    await expect(r.supplierLedgerEntryModel.deleteOne({ _id: e._id })).rejects.toThrow(/append-only/);
    await expect(r.purchaseReceiptModel.deleteMany({})).rejects.toThrow(/append-only/);
    const list = (await sup.payables(device(w.s), w.s.storeId, w.M)).data;
    expect([list.totals.balanceMinor, list.suppliers[0].balanceMinor, list.suppliers[0].currentMinor]).toEqual([1000, 1000, 1000]);
  });

  it('aging: payments settle the OLDEST bills first; the rest sits in current / 30 / 60 / 90+ by the bill date', async () => {
    const { computeAging } = await import('../purchase-orders/supplier-aging.util');
    const now = new Date('2026-11-01T12:00:00Z');
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const a = computeAging([
      { type: 'bill', amountMinor: 1000, at: ago(100) }, { type: 'bill', amountMinor: 2000, at: ago(65) }, { type: 'bill', amountMinor: 3000, at: ago(35) }, { type: 'bill', amountMinor: 4000, at: ago(2) },
      { type: 'payment', amountMinor: -1500, at: ago(10) },
    ], now);
    expect(a).toEqual({ balanceMinor: 8500, d90Minor: 0, d60Minor: 1500, d30Minor: 3000, currentMinor: 4000 });
    expect(computeAging([{ type: 'bill', amountMinor: 500, at: ago(1) }, { type: 'credit', amountMinor: -800, at: ago(0) }], now)).toEqual({ balanceMinor: -300, currentMinor: 0, d30Minor: 0, d60Minor: 0, d90Minor: 0 });
    expect(computeAging([], now).balanceMinor).toBe(0);
    expect(computeAging([{ type: 'bill', amountMinor: 700, at: ago(29) }], now).currentMinor).toBe(700);
    expect(computeAging([{ type: 'bill', amountMinor: 700, at: ago(30) }], now).d30Minor).toBe(700);
    expect(computeAging([{ type: 'bill', amountMinor: 700, at: ago(90) }], now).d90Minor).toBe(700);
  });

  it('through the service: a bill dated by the SUPPLIER invoice date ages from that date', async () => {
    const w = await world();
    const po = await w.approved(10, 100);
    await w.recv(po, 10, { supplierInvoiceDate: day(-70).toISOString() });
    const a = (await w.bal()).aging;
    expect([a.d60Minor, a.currentMinor, a.balanceMinor]).toEqual([1000, 0, 1000]);
  });
});

describe('supplier payments', () => {
  it('cash from the drawer: needs an OPEN shift, lowers the shift\'s expected cash by exactly the amount (decimal + minor), cannot exceed what is owed, retries do not pay twice', async () => {
    const w = await world({ currency: 'KWD' });
    await w.recv(await w.approved(10, 25_000), 10); // 25.000 × 10 = 250.000 owed (KWD, exponent 3)
    const pay = (amountMinor: number, extra: any = {}) => sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor, method: 'cash', sessionId: w.sid, requestId: rid(), ...extra }, w.M);
    expect(await code(sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor: 1000, method: 'cash', requestId: rid() }, w.M))).toBe('NO_OPEN_SHIFT');
    expect(await code(pay(250_001))).toBe('EXCEEDS_BALANCE');
    expect(await code(sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor: 5, method: 'cash', sessionId: w.sid }, w.M))).toBe('REQUEST_ID_REQUIRED');
    const id = rid();
    const a = (await pay(100_000, { requestId: id, reference: 'cash-1' })).data;
    const b = (await pay(100_000, { requestId: id, reference: 'cash-1' })).data; // the same retry
    expect([a.duplicate, b.duplicate, a.balanceMinor]).toEqual([false, true, 150_000]);
    const sh: any = await w.shift();
    expect(sh.cashAdjustments).toHaveLength(1);
    expect(sh.cashAdjustments[0]).toMatchObject({ type: 'cash_out', amount: 100, amountMinor: 100_000, category: 'supplier_payment', refType: 'supplier_payment' });
    // closing the shift counts it: expected cash = opening 50 + sales 0 − 100 cash out (the shift-close arithmetic reads `amount`)
    const out = sh.cashAdjustments.filter((x: any) => x.type === 'cash_out').reduce((t: number, x: any) => t + x.amount, 0);
    expect(sh.openingCash + (sh.cashSales ?? 0) - out).toBe(-50);
    // a bank payment is recorded only: no drawer movement
    await sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor: 50_000, method: 'bank', reference: 'TT-9', requestId: rid() }, w.M);
    expect((await w.shift() as any).cashAdjustments).toHaveLength(1);
    expect((await w.bal()).aging.balanceMinor).toBe(100_000);
    // a closed shift cannot take the cash out
    await r.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(w.sid) }, { $set: { status: 'closed' } });
    expect(await code(pay(1000))).toBe('NO_OPEN_SHIFT');
    expect(await r.supplierLedgerEntryModel.countDocuments({ storeId: w.s.storeId, type: 'payment' })).toBe(2); // the refused one left no trace
  });

  it('a payment above the manager\'s limit needs the owner; a cashier cannot pay at all', async () => {
    const w = await world();
    await r.posSettingsModel.updateOne({ storeId: w.s.storeId }, { $set: { approvalLimits: { purchaseOrderMinor: 100_000_000 } } }, { upsert: true }); // so the PO itself needs no owner
    await w.recv(await w.approved(1000, 1000), 1000); // 10 000.00 owed
    const body = (amountMinor: number) => ({ amountMinor, method: 'bank', requestId: rid() });
    expect(await code(sup.pay(device(w.s), w.s.storeId, w.supplier.id, body(100_000), w.M))).toBe('POS_OWNER_REQUIRED'); // 1 000.00 > the 500.00 default
    expect(await code(sup.pay(device(w.s), w.s.storeId, w.supplier.id, body(100), w.C))).toBe('POS_ACTION_FORBIDDEN');
    expect((await sup.pay(device(w.s), w.s.storeId, w.supplier.id, body(50_000), w.M)).data.balanceMinor).toBe(950_000);
    expect((await sup.pay(owner(w.s), w.s.storeId, w.supplier.id, body(100_000), {})).data.balanceMinor).toBe(850_000);
  });

  it('two payments racing for the same last balance: exactly one is accepted', async () => {
    for (let i = 0; i < 4; i++) {
      const w = await world();
      await w.recv(await w.approved(10, 100), 10); // 10.00 owed
      const res = await Promise.allSettled([1, 2, 3].map(() => sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor: 600, method: 'bank', requestId: rid() }, w.M)));
      expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((await w.bal()).aging.balanceMinor).toBe(400);
    }
  });
});

describe('the money contract: every supply response that carries minor amounts states currency + exponent', () => {
  it('every manager-visible response passes the contract check', async () => {
    const w = await world({ currency: 'KWD', trackLots: true });
    const po = await w.approved(10, 1500);
    const out: any[] = [];
    out.push((await sup.suppliers(device(w.s), w.s.storeId, w.M)).data, (await sup.supplier(device(w.s), w.s.storeId, w.supplier.id, w.M)).data, (await sup.orders(device(w.s), w.s.storeId, {}, w.M)).data, (await sup.order(device(w.s), w.s.storeId, po.id, w.M)).data);
    const rc = await w.recv(po, 6, {}, w.M, { lotNumber: 'X', expiryDate: day(40).toISOString() });
    out.push(rc, (await sup.receipts(device(w.s), w.s.storeId, {}, w.M)).data);
    out.push((await sup.createReturn(device(w.s), w.s.storeId, { receiptId: rc.receipt.id, items: [{ variantId: w.s.variantId, quantity: 1 }] }, w.M)).data, (await sup.returnsList(device(w.s), w.s.storeId, {}, w.M)).data);
    out.push((await sup.pay(device(w.s), w.s.storeId, w.supplier.id, { amountMinor: 1000, method: 'bank', requestId: rid() }, w.M)).data, (await sup.payables(device(w.s), w.s.storeId, w.M)).data, (await sup.ledger(device(w.s), w.s.storeId, w.supplier.id, w.M)).data);
    out.push((await sup.createOrder(device(w.s), w.s.storeId, { supplierId: w.supplier.id, items: [{ variantId: w.s.variantId, quantityOrdered: 1, unitCostMinor: 5 }] }, w.M)).data);
    out.forEach((x, i) => expect([i, moneyContractViolations(x)]).toEqual([i, []]));
    expect(out.every((x) => x.currency === 'KWD' && x.currencyExponent === 3)).toBe(true);
  });
});
