/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB integration tests for inventory correctness (atomic adjustments, stock counts, PO receiving, barcode lookup).
 * Needs a REPLICA SET; skipped unless INVENTORY_IT_MONGO is set, e.g.
 *   INVENTORY_IT_MONGO="mongodb://127.0.0.1:27099/?replicaSet=rs0" npx jest inventory.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ProductSchema } from '../products/schemas/product.schema';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { VariantLocationStockSchema } from './schemas/variant-location-stock.schema';
import { StockAdjustmentSchema } from './schemas/stock-adjustment.schema';
import { StockLotSchema } from './schemas/stock-lot.schema';
import { StockUnitSchema } from './schemas/stock-unit.schema';
import { StoreSchema } from '../store/schemas/store.schema';
import { SellerSchema } from '../seller/seller.schema';
import { StoreLocationSchema } from '../pos/schemas/store-location.schema';
import { StockTransferSchema } from './schemas/stock-transfer.schema';
import { BinSchema } from './schemas/bin.schema';
import { StockCountSchema } from '../stock-counts/schemas/stock-count.schema';
import { PurchaseOrderSchema } from '../purchase-orders/schemas/purchase-order.schema';
import { InventoryService } from './inventory.service';
import { StockCountsService } from '../stock-counts/stock-counts.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { SupplierReturnsService } from '../purchase-orders/supplier-returns.service';
import { SupplierReturnSchema } from '../purchase-orders/schemas/supplier-return.schema';
import { ApprovalRequestSchema } from '../staff/schemas/approval-request.schema';
import { drainLocationStock, restoreLocationStock } from '../common/location-stock.util';
import { consumeLots } from '../common/lot-consumption.util';
import { refreshAllExpiredStock, refreshExpiredStock } from '../common/expired-stock.util';
import { AVAILABLE_STOCK_EXPR } from '../common/stock-availability.util';

const URI = process.env.INVENTORY_IT_MONGO;
const d = URI ? describe : describe.skip;

d('Inventory on a real replica set', () => {
  let conn: Connection;
  let r: any;
  let inv: InventoryService;
  let counts: StockCountsService;
  let pos: PurchaseOrdersService;
  let returns: SupplierReturnsService;
  let SELLER: string;
  let STORE: string;
  let LOC1: string;
  let LOC2: string;

  const oid = () => new Types.ObjectId();
  const mkVariant = async (stock: number, extra: any = {}) => {
    const pid = oid();
    await r.productModel.collection.insertOne({ _id: pid, storeId: STORE, sellerId: SELLER, isDelete: false, status: 'active', type: 'physical', name: 'P' + pid, slug: 's' + pid });
    const vid = oid();
    await r.productVariantModel.collection.insertOne({
      _id: vid, productId: String(pid), storeId: STORE, sku: 'SKU-' + vid, price: 5, stock, committedStock: 0, damagedStock: 0, inTransitStock: 0,
      isDelete: false, isDefault: true, options: [], unlimitedStock: false, createdAt: new Date(), ...extra,
    });
    return { pid: String(pid), vid: String(vid) };
  };

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `inventory_it_${Date.now()}` }).asPromise();
    r = {
      productModel: conn.model('Product', ProductSchema),
      productVariantModel: conn.model('ProductVariant', ProductVariantSchema),
      variantLocationStockModel: conn.model('VariantLocationStock', VariantLocationStockSchema),
      stockAdjustmentModel: conn.model('StockAdjustment', StockAdjustmentSchema),
      stockLotModel: conn.model('StockLot', StockLotSchema),
      stockUnitModel: conn.model('StockUnit', StockUnitSchema),
      storeModel: conn.model('Store', StoreSchema),
      sellerModel: conn.model('Seller', SellerSchema),
      storeLocationModel: conn.model('StoreLocation', StoreLocationSchema),
      stockCountModel: conn.model('StockCount', StockCountSchema),
      stockTransferModel: conn.model('StockTransfer', StockTransferSchema),
      binModel: conn.model('Bin', BinSchema),
      purchaseOrderModel: conn.model('PurchaseOrder', PurchaseOrderSchema),
      supplierReturnModel: conn.model('SupplierReturn', SupplierReturnSchema),
      supplierModel: conn.model('Supplier', new mongoose.Schema({}, { strict: false })),
      orderModel: conn.model('Order', new mongoose.Schema({}, { strict: false })),
      approvalRequestModel: conn.model('ApprovalRequest', ApprovalRequestSchema),
      staffMemberModel: conn.model('StaffMember', new mongoose.Schema({ name: String }, { strict: false })),
    };
    for (const m of Object.values(r) as any[]) { try { await m.createIndexes(); } catch { /* unrelated pre-existing index definitions */ } }
    const db: any = { repositories: r };
    const activity: any = { log: jest.fn(async () => undefined) };
    inv = new InventoryService(db, { isConnected: false } as any, { notify: jest.fn() } as any, conn as any);
    counts = new StockCountsService(db, activity, conn as any);
    returns = new SupplierReturnsService(db, activity, inv, conn as any);
    returns.onModuleInit(); // registers how a queued supplier return is applied on approval
    pos = new PurchaseOrdersService(db, activity, inv, { notify: jest.fn() } as any, { sendMail: jest.fn() } as any, { get: jest.fn() } as any, conn as any);

    const sid = oid(); SELLER = String(sid);
    await r.sellerModel.collection.insertOne({ _id: sid, name: 'Seller', status: 'active', isDelete: false });
    const st = oid(); STORE = String(st);
    await r.storeModel.collection.insertOne({ _id: st, sellerId: SELLER, status: 'active', isDelete: false, baseCurrency: 'USD', name: 'S', slug: 's' });
    const l1 = oid(); const l2 = oid(); LOC1 = String(l1); LOC2 = String(l2);
    await r.storeLocationModel.collection.insertMany([
      { _id: l1, storeId: STORE, name: 'Main', isDefault: true, isDelete: false, createdAt: new Date(1) },
      { _id: l2, storeId: STORE, name: 'Shop', isDefault: false, isDelete: false, createdAt: new Date(2) },
    ]);
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  describe('adjustments', () => {
    it('50 concurrent -1 adjustments on stock 20 => exactly 20 succeed, never below 0, audit rows match', async () => {
      const { vid } = await mkVariant(20);
      const res = await Promise.allSettled(Array.from({ length: 50 }, () => inv.adjustStock(SELLER, STORE, vid, -1, 'other' as any, 'x')));
      const ok = res.filter((x) => x.status === 'fulfilled').length;
      expect(ok).toBe(20);
      expect(res.filter((x) => x.status === 'rejected').every((x: any) => x.reason instanceof BadRequestException)).toBe(true);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(0);
      expect(await r.stockAdjustmentModel.countDocuments({ variantId: vid })).toBe(20);
    });

    it('cannot reduce below reserved (committed) units', async () => {
      const { vid } = await mkVariant(10, { committedStock: 8 });
      await expect(inv.adjustStock(SELLER, STORE, vid, -5, 'other' as any)).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(10);
    });

    it('location adjustments: row + variant total move together; concurrent mixed adjustments never lose an update', async () => {
      const { vid } = await mkVariant(10);
      await inv.adjustStock(SELLER, STORE, vid, 5, 'restocked' as any, 'seed', LOC1); // seeds default location with 10 then +5
      const res = await Promise.allSettled([
        ...Array.from({ length: 10 }, () => inv.adjustStock(SELLER, STORE, vid, 1, 'restocked' as any, 'a', LOC1)),
        ...Array.from({ length: 10 }, () => inv.adjustStock(SELLER, STORE, vid, 2, 'restocked' as any, 'b', LOC2)),
      ]);
      expect(res.every((x) => x.status === 'fulfilled')).toBe(true);
      const rows = await r.variantLocationStockModel.find({ variantId: vid }).lean();
      const sum = rows.reduce((s: number, x: any) => s + x.stock, 0);
      const v = await r.productVariantModel.findById(vid);
      expect(v.stock).toBe(10 + 5 + 10 + 20);
      expect(sum).toBe(v.stock);
    });

    it('location floor: cannot take a location below 0 and a refused adjustment changes nothing', async () => {
      const { vid } = await mkVariant(4);
      await inv.adjustStock(SELLER, STORE, vid, 1, 'restocked' as any, 'seed', LOC1);
      await expect(inv.adjustStock(SELLER, STORE, vid, -9, 'other' as any, 'x', LOC1)).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(5);
      expect((await r.variantLocationStockModel.findOne({ variantId: vid, locationId: LOC1 })).stock).toBe(5);
    });
  });

  describe('stock counts', () => {
    it('only one open count per store, even when started concurrently', async () => {
      await mkVariant(3);
      const res = await Promise.allSettled([counts.start(STORE, SELLER), counts.start(STORE, SELLER), counts.start(STORE, SELLER)]);
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
      const open: any = await r.stockCountModel.findOne({ storeId: STORE, status: 'open' });
      await counts.cancel(STORE, SELLER, String(open._id));
    });

    it('finish applies the DIFFERENCE, so a sale made while counting is kept (no overwrite), and writes an audit row', async () => {
      const { vid } = await mkVariant(10);
      const started: any = await counts.start(STORE, SELLER);
      const item = started.items.find((i: any) => i.variantId === vid);
      await counts.submitCount(STORE, SELLER, String(started._id), String(item._id), 8); // counted 8, book said 10 => -2
      await r.productVariantModel.updateOne({ _id: vid }, { $inc: { stock: -3 } }); // a sale of 3 happens during the count
      const out: any = await counts.finish(STORE, SELLER, String(started._id));
      expect(out.applied).toBeGreaterThanOrEqual(1);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(5); // 10 - 3 sale - 2 count difference (NOT overwritten to 8)
      const adj = await r.stockAdjustmentModel.findOne({ variantId: vid, reason: 'correction' });
      expect(adj.delta).toBe(-2);
    });

    it('double / concurrent finish applies the count exactly once', async () => {
      const { vid } = await mkVariant(10);
      const started: any = await counts.start(STORE, SELLER);
      const item = started.items.find((i: any) => i.variantId === vid);
      await counts.submitCount(STORE, SELLER, String(started._id), String(item._id), 6);
      const res = await Promise.allSettled([counts.finish(STORE, SELLER, String(started._id)), counts.finish(STORE, SELLER, String(started._id)), counts.finish(STORE, SELLER, String(started._id))]);
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(6);
      expect(await r.stockAdjustmentModel.countDocuments({ variantId: vid, reason: 'correction' })).toBe(1);
    });

    it('count below reserved units fails the WHOLE count (nothing half-applied) and stays retryable', async () => {
      const a = await mkVariant(10);
      const b = await mkVariant(10, { committedStock: 9 });
      const started: any = await counts.start(STORE, SELLER);
      const ia = started.items.find((i: any) => i.variantId === a.vid);
      const ib = started.items.find((i: any) => i.variantId === b.vid);
      await counts.submitCount(STORE, SELLER, String(started._id), String(ia._id), 7);
      await counts.submitCount(STORE, SELLER, String(started._id), String(ib._id), 2);
      await expect(counts.finish(STORE, SELLER, String(started._id))).rejects.toBeDefined();
      expect((await r.productVariantModel.findById(a.vid)).stock).toBe(10);
      expect((await r.stockCountModel.findById(started._id)).status).toBe('open');
      await counts.cancel(STORE, SELLER, String(started._id));
    });

    it('submitCount rejects fractions/negatives and parallel line updates do not overwrite each other', async () => {
      const a = await mkVariant(1); const b = await mkVariant(1);
      const started: any = await counts.start(STORE, SELLER);
      const ia = started.items.find((i: any) => i.variantId === a.vid); const ib = started.items.find((i: any) => i.variantId === b.vid);
      await expect(counts.submitCount(STORE, SELLER, String(started._id), String(ia._id), 1.5)).rejects.toBeInstanceOf(BadRequestException);
      await expect(counts.submitCount(STORE, SELLER, String(started._id), String(ia._id), -1)).rejects.toBeInstanceOf(BadRequestException);
      await Promise.all([counts.submitCount(STORE, SELLER, String(started._id), String(ia._id), 4), counts.submitCount(STORE, SELLER, String(started._id), String(ib._id), 5)]);
      const fresh: any = await r.stockCountModel.findById(started._id).lean();
      expect(fresh.items.find((i: any) => i.variantId === a.vid).countedQty).toBe(4);
      expect(fresh.items.find((i: any) => i.variantId === b.vid).countedQty).toBe(5);
      await counts.cancel(STORE, SELLER, String(started._id));
    });
  });

  describe('purchase order receiving', () => {
    const mkPo = async (vid: string, pid: string, qty: number, extra: any = {}) => {
      const id = oid();
      await r.purchaseOrderModel.collection.insertOne({
        _id: id, storeId: STORE, sellerId: SELLER, supplierName: 'Sup', poNumber: 'PO-' + id, status: 'ordered', locationId: null, receivedRequestIds: [],
        items: [{ _id: oid(), productId: pid, variantId: vid, name: 'Item', sku: 'S', options: [], quantityOrdered: qty, quantityReceived: 0, quantityDamaged: 0, unitCost: 2 }],
        subtotal: qty * 2, total: qty * 2, createdBy: SELLER, currency: 'USD', createdAt: new Date(), ...extra,
      });
      const po: any = await r.purchaseOrderModel.findById(id).lean();
      return { id: String(id), itemId: String(po.items[0]._id) };
    };

    it('5 concurrent identical receipts: PO ends consistent and stock equals what the PO recorded (no double-credit, no lost update)', async () => {
      const { vid, pid } = await mkVariant(0);
      const { id, itemId } = await mkPo(vid, pid, 100);
      const res = await Promise.allSettled(Array.from({ length: 5 }, () => pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 10 }] } as any)));
      const ok = res.filter((x) => x.status === 'fulfilled').length;
      expect(ok).toBe(5); // distinct receipts of 10 each are all legitimate...
      const po: any = await r.purchaseOrderModel.findById(id).lean();
      expect(po.items[0].quantityReceived).toBe(10 * ok); // ...and the PO counter reflects every one (no lost update)
      expect((await r.productVariantModel.findById(vid)).stock).toBe(10 * ok); // stock == PO record
      expect(await r.stockAdjustmentModel.countDocuments({ variantId: vid, reason: 'purchase_received' })).toBe(ok);
    });

    it('same requestId twice (double click/retry) is a no-op the second time', async () => {
      const { vid, pid } = await mkVariant(0);
      const { id, itemId } = await mkPo(vid, pid, 50);
      const dto: any = { requestId: 'req-1', items: [{ itemId, quantityReceived: 7 }] };
      const first: any = await pos.receive(STORE, SELLER, id, dto);
      const second: any = await pos.receive(STORE, SELLER, id, dto);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(7);
    });

    it('same requestId sent concurrently credits stock once', async () => {
      const { vid, pid } = await mkVariant(0);
      const { id, itemId } = await mkPo(vid, pid, 50);
      const dto: any = { requestId: 'req-2', items: [{ itemId, quantityReceived: 7 }] };
      await Promise.allSettled([pos.receive(STORE, SELLER, id, dto), pos.receive(STORE, SELLER, id, dto), pos.receive(STORE, SELLER, id, dto)]);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(7);
    });

    it('partial receive then complete; damaged units go to damagedStock; weighted-average cost updates', async () => {
      const { vid, pid } = await mkVariant(10, { costPrice: 1 });
      const { id, itemId } = await mkPo(vid, pid, 10); // unit cost 2
      const part: any = await pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 4, quantityDamaged: 1 }] } as any);
      expect(part.po.status).toBe('partially_received');
      const done: any = await pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 5 }] } as any);
      expect(done.po.status).toBe('received');
      const v = await r.productVariantModel.findById(vid);
      expect(v.stock).toBe(20);
      expect(v.damagedStock).toBe(1);
      expect(v.costPrice).toBeGreaterThan(1);
    });

    it('a failure mid-receipt rolls everything back (stock, PO counters, audit rows)', async () => {
      const { vid, pid } = await mkVariant(0);
      const { id, itemId } = await mkPo(vid, pid, 10);
      const spy = jest.spyOn(r.stockAdjustmentModel, 'create').mockRejectedValueOnce(new Error('boom'));
      await expect(pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 3 }] } as any)).rejects.toThrow('boom');
      spy.mockRestore();
      expect((await r.productVariantModel.findById(vid)).stock).toBe(0);
      expect((await r.purchaseOrderModel.findById(id).lean() as any).items[0].quantityReceived).toBe(0);
    });

    it('rejects fractions, negatives and the same line twice in one receipt', async () => {
      const { vid, pid } = await mkVariant(0);
      const { id, itemId } = await mkPo(vid, pid, 10);
      await expect(pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 1.5 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: -1 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
      await expect(pos.receive(STORE, SELLER, id, { items: [{ itemId, quantityReceived: 1 }, { itemId, quantityReceived: 1 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('transfers', () => {
    const seed = async (stock: number) => {
      const { vid } = await mkVariant(stock);
      await inv.adjustStock(SELLER, STORE, vid, 1, 'restocked' as any, 'seed', LOC1); // seeds LOC1 with stock, then +1
      return { vid, total: stock + 1 };
    };

    it('ship is atomic and refuses fractions / more than the source holds', async () => {
      const { vid } = await seed(5);
      await expect(inv.shipTransfer(SELLER, STORE, vid, LOC1, LOC2, 1.5)).rejects.toBeInstanceOf(BadRequestException);
      await expect(inv.shipTransfer(SELLER, STORE, vid, LOC1, LOC2, 99)).rejects.toBeInstanceOf(BadRequestException);
      const v = await r.productVariantModel.findById(vid);
      expect(v.inTransitStock).toBe(0);
      expect((await r.variantLocationStockModel.findOne({ variantId: vid, locationId: LOC1 })).stock).toBe(6);
    });

    it('20 concurrent single-unit receipts of a 10-unit transfer => exactly 10 succeed; destination gets exactly 10', async () => {
      const { vid } = await seed(9);
      const t: any = (await inv.shipTransfer(SELLER, STORE, vid, LOC1, LOC2, 10)).data;
      const res = await Promise.allSettled(Array.from({ length: 20 }, () => inv.receiveTransfer(SELLER, STORE, String(t._id), 1)));
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(10);
      const dest = await r.variantLocationStockModel.findOne({ variantId: vid, locationId: LOC2 });
      expect(dest.stock).toBe(10);
      const v = await r.productVariantModel.findById(vid);
      expect(v.inTransitStock).toBe(0);
      expect((await r.stockTransferModel.findById(t._id)).status).toBe('received');
    });

    it('receive racing cancel: exactly one wins and stock is never duplicated or lost', async () => {
      const { vid, total } = await seed(9);
      const t: any = (await inv.shipTransfer(SELLER, STORE, vid, LOC1, LOC2, 10)).data;
      const res = await Promise.allSettled([inv.receiveTransfer(SELLER, STORE, String(t._id), 10), inv.cancelTransfer(SELLER, STORE, String(t._id))]);
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
      const rows = await r.variantLocationStockModel.find({ variantId: vid }).lean();
      const sum = rows.reduce((a: number, x: any) => a + x.stock, 0);
      const v = await r.productVariantModel.findById(vid);
      expect(sum + v.inTransitStock).toBe(total);
      expect(v.inTransitStock).toBe(0);
    });
  });

  describe('location rows follow every stock movement', () => {
    it('drain takes from the preferred location first, then the biggest row; never below 0; restore goes back to the preferred/default row', async () => {
      const { vid } = await mkVariant(10);
      await r.variantLocationStockModel.collection.insertMany([
        { variantId: vid, locationId: LOC1, storeId: STORE, productId: 'p', stock: 6 },
        { variantId: vid, locationId: LOC2, storeId: STORE, productId: 'p', stock: 4 },
      ]);
      expect(await drainLocationStock(r, vid, 5, { preferLocationId: LOC2 })).toBe(5); // 4 from LOC2, 1 from LOC1
      const rows = Object.fromEntries((await r.variantLocationStockModel.find({ variantId: vid }).lean()).map((x: any) => [x.locationId, x.stock]));
      expect(rows[LOC2]).toBe(0); expect(rows[LOC1]).toBe(5);
      expect(await drainLocationStock(r, vid, 99)).toBe(5); // only 5 left in rows
      await restoreLocationStock(r, vid, 3, { preferLocationId: LOC2 });
      expect((await r.variantLocationStockModel.findOne({ variantId: vid, locationId: LOC2 })).stock).toBe(3);
    });

    it('is a no-op for a variant with no location rows (single-location store)', async () => {
      const { vid } = await mkVariant(10);
      expect(await drainLocationStock(r, vid, 3)).toBe(0);
      expect(await restoreLocationStock(r, vid, 3)).toBe(false);
    });

    it('30 concurrent drains of 1 from a 10-unit row take exactly 10', async () => {
      const { vid } = await mkVariant(10);
      await r.variantLocationStockModel.collection.insertOne({ variantId: vid, locationId: LOC1, storeId: STORE, productId: 'p', stock: 10 });
      const taken = await Promise.all(Array.from({ length: 30 }, () => drainLocationStock(r, vid, 1)));
      expect(taken.reduce((a, b) => a + b, 0)).toBe(10);
      expect((await r.variantLocationStockModel.findOne({ variantId: vid })).stock).toBe(0);
    });
  });

  describe('lots: FEFO consumption, expiry, write-off', () => {
    const mkLot = (vid: string, pid: string, qty: number, cost: number, expiry: Date | null, extra: any = {}) =>
      r.stockLotModel.collection.insertOne({ storeId: STORE, productId: pid, variantId: vid, locationId: null, lotNumber: 'L' + Math.random().toString(36).slice(2, 6), expiryDate: expiry, quantityReceived: qty, quantityRemaining: qty, costPrice: cost, status: 'active', receivedAt: new Date(), ...extra });
    const day = 86_400_000;

    it('consumes soonest-expiring first, no-expiry lots next, already-expired lots last; cost = what was actually taken', async () => {
      const { vid, pid } = await mkVariant(30, { trackLots: true });
      await mkLot(vid, pid, 10, 1, null, { lotNumber: 'NOEXP' });
      await mkLot(vid, pid, 10, 2, new Date(Date.now() + 5 * day), { lotNumber: 'SOON' });
      await mkLot(vid, pid, 10, 9, new Date(Date.now() - 2 * day), { lotNumber: 'EXPIRED' });
      const cost = await consumeLots(r, vid, 15); // 10 from SOON (@2) + 5 from NOEXP (@1)
      expect(cost).toBe(25);
      const lots = Object.fromEntries((await r.stockLotModel.find({ variantId: vid }).lean()).map((l: any) => [l.lotNumber, l]));
      expect(lots.SOON.quantityRemaining).toBe(0); expect(lots.SOON.status).toBe('depleted');
      expect(lots.NOEXP.quantityRemaining).toBe(5);
      expect(lots.EXPIRED.quantityRemaining).toBe(10);
    });

    it('concurrent consumers never take the same unit twice', async () => {
      const { vid, pid } = await mkVariant(10, { trackLots: true });
      await mkLot(vid, pid, 10, 1, null);
      await Promise.all(Array.from({ length: 20 }, () => consumeLots(r, vid, 1)));
      const total = (await r.stockLotModel.find({ variantId: vid }).lean()).reduce((a: number, l: any) => a + l.quantityRemaining, 0);
      expect(total).toBe(0);
    });

    it('listLots flags expired / expiring lots; write-off moves lot + stock + audit together and cannot over-write-off', async () => {
      const { vid, pid } = await mkVariant(12, { trackLots: true });
      await mkLot(vid, pid, 5, 2, new Date(Date.now() - day), { lotNumber: 'OLD' });
      await mkLot(vid, pid, 7, 3, new Date(Date.now() + 10 * day), { lotNumber: 'NEWER' });
      const expired: any = await inv.listLots(SELLER, STORE, { filter: 'expired', q: 'OLD' });
      expect(expired.data).toHaveLength(1);
      expect(expired.data[0]).toMatchObject({ lotNumber: 'OLD', isExpired: true, valueRemaining: 10 });
      const soon: any = await inv.listLots(SELLER, STORE, { filter: 'expiring', days: 30, q: 'NEWER' });
      expect(soon.data[0].daysToExpiry).toBeGreaterThan(0);
      const lotId = String(expired.data[0]._id);
      await expect(inv.writeOffLot(SELLER, STORE, lotId, { quantity: 9 })).rejects.toBeInstanceOf(BadRequestException);
      const out: any = await inv.writeOffLot(SELLER, STORE, lotId, { reason: 'expired', note: 'binned' });
      expect(out.data).toMatchObject({ written: 5, remaining: 0, newStock: 7, value: 10 });
      expect((await r.stockLotModel.findById(lotId)).status).toBe('expired');
      expect((await r.productVariantModel.findById(vid)).stock).toBe(7);
      expect(await r.stockAdjustmentModel.countDocuments({ variantId: vid, reason: 'expired', delta: -5 })).toBe(1);
      await expect(inv.writeOffLot(SELLER, STORE, lotId, {})).rejects.toBeDefined(); // already written off
    });

    it('concurrent write-offs of the same lot remove the units once', async () => {
      const { vid, pid } = await mkVariant(5, { trackLots: true });
      await mkLot(vid, pid, 5, 1, new Date(Date.now() - day), { lotNumber: 'ONCE' });
      const lot: any = await r.stockLotModel.findOne({ variantId: vid });
      const res = await Promise.allSettled(Array.from({ length: 4 }, () => inv.writeOffLot(SELLER, STORE, String(lot._id), { quantity: 5 })));
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(0);
    });

    it('staff without inventory.approve cannot write off', async () => {
      const { vid, pid } = await mkVariant(5, { trackLots: true });
      await mkLot(vid, pid, 5, 1, null);
      const lot: any = await r.stockLotModel.findOne({ variantId: vid });
      await expect(inv.writeOffLot(SELLER, STORE, String(lot._id), {}, { actorId: 's', actorRole: 'staff', actorPermissions: ['inventory.adjust'] })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('supplier returns', () => {
    const mkPoFor = async (vid: string, pid: string, received: number, cost = 2) => {
      const id = oid();
      await r.purchaseOrderModel.collection.insertOne({
        _id: id, storeId: STORE, sellerId: SELLER, supplierName: 'Acme', poNumber: 'PO-' + id, status: 'received', locationId: null, receivedRequestIds: [],
        items: [{ _id: oid(), productId: pid, variantId: vid, name: 'Item', sku: 'S', options: [], quantityOrdered: received, quantityReceived: received, quantityDamaged: 0, quantityReturned: 0, unitCost: cost }],
        subtotal: received * cost, total: received * cost, createdBy: SELLER, currency: 'USD', createdAt: new Date(),
      });
      return String(id);
    };

    it('removes stock from variant + location, re-weights average cost, writes audit, and tracks the credit', async () => {
      const { vid } = await mkVariant(10, { costPrice: 4 });
      await r.variantLocationStockModel.collection.insertOne({ variantId: vid, locationId: LOC1, storeId: STORE, productId: 'p', stock: 10 });
      const out: any = await returns.create(STORE, SELLER, { supplierName: 'Acme', reason: 'defective', items: [{ variantId: vid, quantity: 4, unitCost: 1 }] } as any);
      expect(out.data.totalCredit).toBe(4);
      const v = await r.productVariantModel.findById(vid);
      expect(v.stock).toBe(6);
      expect(v.costPrice).toBe(6); // (10*4 - 4*1) / 6
      expect((await r.variantLocationStockModel.findOne({ variantId: vid })).stock).toBe(6);
      expect(await r.stockAdjustmentModel.countDocuments({ variantId: vid, reason: 'supplier_return', delta: -4 })).toBe(1);
      const done: any = await returns.markCreditReceived(STORE, SELLER, String(out.data._id));
      expect(done.data.creditStatus).toBe('received');
      await expect(returns.markCreditReceived(STORE, SELLER, String(out.data._id))).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cannot return reserved or damaged units as sellable stock, nor more than a PO line received', async () => {
      const { vid, pid } = await mkVariant(10, { committedStock: 7 });
      await expect(returns.create(STORE, SELLER, { supplierName: 'A', items: [{ variantId: vid, quantity: 5 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(10);
      const poId = await mkPoFor(vid, pid, 3);
      await expect(returns.create(STORE, SELLER, { purchaseOrderId: poId, items: [{ variantId: vid, quantity: 4 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
      await returns.create(STORE, SELLER, { purchaseOrderId: poId, items: [{ variantId: vid, quantity: 3 }] } as any);
      await expect(returns.create(STORE, SELLER, { purchaseOrderId: poId, items: [{ variantId: vid, quantity: 1 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.purchaseOrderModel.findById(poId).lean() as any).items[0].quantityReturned).toBe(3);
    });

    it('damaged units can be returned from the damaged pool', async () => {
      const { vid } = await mkVariant(10, { damagedStock: 3 });
      await returns.create(STORE, SELLER, { supplierName: 'A', items: [{ variantId: vid, quantity: 3, fromDamaged: true }] } as any);
      const v = await r.productVariantModel.findById(vid);
      expect(v.stock).toBe(7); expect(v.damagedStock).toBe(0);
    });

    it('a failure on a later line rolls the whole return back; same requestId twice / concurrently removes stock once', async () => {
      const a = await mkVariant(5); const b = await mkVariant(1);
      await expect(returns.create(STORE, SELLER, { supplierName: 'A', items: [{ variantId: a.vid, quantity: 2 }, { variantId: b.vid, quantity: 9 }] } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.productVariantModel.findById(a.vid)).stock).toBe(5);
      const dto: any = { supplierName: 'A', requestId: 'sr-1', items: [{ variantId: a.vid, quantity: 2 }] };
      await Promise.allSettled([returns.create(STORE, SELLER, dto), returns.create(STORE, SELLER, dto), returns.create(STORE, SELLER, dto)]);
      expect((await r.productVariantModel.findById(a.vid)).stock).toBe(3);
      expect(await r.supplierReturnModel.countDocuments({ storeId: STORE, requestId: 'sr-1' })).toBe(1);
    });

    it('concurrent returns never push stock below zero', async () => {
      const { vid } = await mkVariant(10);
      const res = await Promise.allSettled(Array.from({ length: 15 }, () => returns.create(STORE, SELLER, { supplierName: 'A', items: [{ variantId: vid, quantity: 1 }] } as any)));
      expect(res.filter((x) => x.status === 'fulfilled').length).toBe(10);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(0);
    });

    it('movement report sums adjustments by reason, supplier returns and expiry exposure', async () => {
      const rep: any = await inv.getMovementReport(SELLER, STORE, {});
      const reasons = rep.data.adjustmentsByReason.map((x: any) => x.reason);
      expect(reasons).toEqual(expect.arrayContaining(['supplier_return', 'expired']));
      expect(rep.data.supplierReturns.count).toBeGreaterThan(0);
      await expect(inv.getMovementReport(SELLER, STORE, { from: '2020-01-01', to: '2026-01-01' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(inv.getMovementReport('other-seller', STORE, {})).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('expired lots are not sellable (enforced in the atomic availability guard)', () => {
    const day = 86_400_000;
    const mkLot = (vid: string, pid: string, qty: number, expiry: Date | null, extra: any = {}) =>
      r.stockLotModel.collection.insertOne({ storeId: STORE, productId: pid, variantId: vid, locationId: null, lotNumber: 'X' + Math.random().toString(36).slice(2, 6), expiryDate: expiry, quantityReceived: qty, quantityRemaining: qty, costPrice: 1, status: 'active', receivedAt: new Date(), ...extra });
    // the exact reservation guard checkout / payment / exchange / POS / draft orders use
    const reserve = (vid: string, qty: number) => r.productVariantModel.updateOne({ _id: vid, isDelete: false, $expr: { $gte: [AVAILABLE_STOCK_EXPR, qty] } }, { $inc: { committedStock: qty } });

    it('cron marks units in expired lots; the reservation guard then refuses them, fresh units stay sellable, and write-off restores nothing it should not', async () => {
      const { vid, pid } = await mkVariant(10, { trackLots: true });
      await mkLot(vid, pid, 4, new Date(Date.now() - day), { lotNumber: 'GONE' });
      await mkLot(vid, pid, 6, new Date(Date.now() + 30 * day), { lotNumber: 'FRESH' });
      expect((await reserve(vid, 10)).modifiedCount).toBe(1); // before the refresh the 4 expired units still look sellable...
      await r.productVariantModel.updateOne({ _id: vid }, { $set: { committedStock: 0 } });
      await refreshAllExpiredStock(r); // ...the 5-minute cron (or any lot change) flags them
      expect((await r.productVariantModel.findById(vid)).expiredStock).toBe(4);
      expect((await reserve(vid, 7)).modifiedCount).toBe(0); // only 6 sellable
      expect((await reserve(vid, 6)).modifiedCount).toBe(1);
      expect((await reserve(vid, 1)).modifiedCount).toBe(0);
      const hit: any = await inv.lookupByCode(SELLER, STORE, 'SKU-' + vid);
      expect(hit.data[0].available).toBe(0); // 10 - 6 committed - 4 expired
    });

    it('a lot that crosses its expiry date is picked up by the cron and cleared again once written off', async () => {
      const { vid, pid } = await mkVariant(5, { trackLots: true });
      await mkLot(vid, pid, 5, new Date(Date.now() + 60_000), { lotNumber: 'SOON' });
      await refreshAllExpiredStock(r);
      expect((await r.productVariantModel.findById(vid)).expiredStock).toBe(0);
      await refreshAllExpiredStock(r, new Date(Date.now() + 120_000)); // two minutes later it has expired
      expect((await r.productVariantModel.findById(vid)).expiredStock).toBe(5);
      const lot: any = await r.stockLotModel.findOne({ variantId: vid });
      await inv.writeOffLot(SELLER, STORE, String(lot._id), { reason: 'expired' });
      expect((await r.productVariantModel.findById(vid)).expiredStock).toBe(0);
      await refreshAllExpiredStock(r);
      expect((await r.productVariantModel.findById(vid)).expiredStock).toBe(0);
    });

    it('selling (FEFO) takes fresh lots, so expired units stay flagged and unsellable; receiving an already-expired lot flags it at once', async () => {
      const { vid, pid } = await mkVariant(10, { trackLots: true });
      await mkLot(vid, pid, 3, new Date(Date.now() - day), { lotNumber: 'OLD' });
      await mkLot(vid, pid, 7, null, { lotNumber: 'EVERGREEN' });
      await consumeLots(r, vid, 2);
      const lots = Object.fromEntries((await r.stockLotModel.find({ variantId: vid }).lean()).map((l: any) => [l.lotNumber, l.quantityRemaining]));
      expect(lots).toEqual({ OLD: 3, EVERGREEN: 5 });
      expect((await r.productVariantModel.findById(vid)).expiredStock).toBe(3);
      await mkLot(vid, pid, 2, new Date(Date.now() - 1000), { lotNumber: 'DOA' });
      expect(await refreshExpiredStock(r, vid)).toBe(5);
    });

    it('concurrent reservations never exceed sellable (non-expired) units', async () => {
      const { vid, pid } = await mkVariant(10, { trackLots: true });
      await mkLot(vid, pid, 6, new Date(Date.now() - day));
      await mkLot(vid, pid, 4, null);
      await refreshAllExpiredStock(r);
      const res = await Promise.all(Array.from({ length: 12 }, () => reserve(vid, 1)));
      expect(res.filter((x: any) => x.modifiedCount === 1).length).toBe(4);
      expect((await r.productVariantModel.findById(vid)).committedStock).toBe(4);
    });
  });

  describe('supplier return permissions', () => {
    const staff = (perms: string[]) => ({ role: 'staff', permissions: perms });

    it('staff need inventory.adjust; a large return without inventory.approve is queued, not applied; owners are unrestricted', async () => {
      const { vid } = await mkVariant(100);
      const small: any = { supplierName: 'A', items: [{ variantId: vid, quantity: 2 }] };
      const big: any = { supplierName: 'A', items: [{ variantId: vid, quantity: 25 }] };
      await expect(returns.create(STORE, SELLER, small, 's1', staff(['purchase_orders.manage']))).rejects.toBeInstanceOf(ForbiddenException);
      const queued: any = await returns.create(STORE, SELLER, big, 's1', staff(['purchase_orders.manage', 'inventory.adjust']));
      expect(queued.pendingApproval).toBe(true);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(100); // queued, stock untouched
      await returns.create(STORE, SELLER, small, 's1', staff(['purchase_orders.manage', 'inventory.adjust']));
      await returns.create(STORE, SELLER, big, 's1', staff(['purchase_orders.manage', 'inventory.adjust', 'inventory.approve']));
      await returns.create(STORE, SELLER, small, SELLER, { role: 'seller', permissions: null });
      expect((await r.productVariantModel.findById(vid)).stock).toBe(100 - 2 - 25 - 2);
    });
  });

  describe('exact expiry (no waiting for the cron)', () => {
    it('a lot that expires in 6s becomes unsellable at that moment, with NO refresh in between', async () => {
      const { vid, pid } = await mkVariant(5, { trackLots: true });
      await r.stockLotModel.collection.insertOne({ storeId: STORE, productId: pid, variantId: vid, locationId: null, lotNumber: 'TICK', expiryDate: new Date(Date.now() + 6000), quantityReceived: 5, quantityRemaining: 5, costPrice: 1, status: 'active', receivedAt: new Date() });
      await refreshAllExpiredStock(r); // stores the upcoming expiry as a bucket
      const reserve = (qty: number) => r.productVariantModel.updateOne({ _id: vid, $expr: { $gte: [AVAILABLE_STOCK_EXPR, qty] } }, { $inc: { committedStock: qty } });
      expect((await reserve(2)).modifiedCount).toBe(1); // still sellable
      await new Promise((res) => setTimeout(res, 6500));
      expect((await reserve(1)).modifiedCount).toBe(0); // expired by the clock alone: not allocatable
      const v = await r.productVariantModel.findById(vid);
      expect(v.expiredStock).toBe(0); // nothing refreshed it — the guard used the bucket + $$NOW
      const hit: any = await inv.lookupByCode(SELLER, STORE, 'SKU-' + vid);
      expect(hit.data[0].available).toBe(0);
    }, 30000);
  });

  describe('valuation and stock lines with expired stock', () => {
    it('inventory value excludes expired lots and reports them separately; stock lines show available without double-counting in-transit', async () => {
      const { vid, pid } = await mkVariant(10, { trackLots: true, costPrice: 2, inTransitStock: 2 });
      await r.stockLotModel.collection.insertMany([
        { storeId: STORE, productId: pid, variantId: vid, locationId: null, lotNumber: 'LIVE', expiryDate: null, quantityReceived: 6, quantityRemaining: 6, costPrice: 2, status: 'active', receivedAt: new Date() },
        { storeId: STORE, productId: pid, variantId: vid, locationId: null, lotNumber: 'DEAD', expiryDate: new Date(Date.now() - 86_400_000), quantityReceived: 4, quantityRemaining: 4, costPrice: 5, status: 'active', receivedAt: new Date() },
      ]);
      await refreshExpiredStock(r, vid);
      const val: any = await inv.getValuation(SELLER, STORE);
      expect(val.data.expiredUnits).toBeGreaterThanOrEqual(4);
      expect(val.data.expiredValue).toBeGreaterThanOrEqual(20);
      const lines: any = await inv.getStockLines(SELLER, STORE, { search: 'SKU-' + vid });
      const line = lines.data.lines.find((l: any) => l.variantId === vid);
      expect(line.expiredStock).toBe(4);
      expect(line.available).toBe(4); // 10 on hand - 2 in transit - 4 expired (in-transit subtracted once)
    });
  });

  describe('supplier return approval queue', () => {
    const staffBase = ['purchase_orders.manage', 'inventory.adjust'];
    const big = (vid: string, qty = 25): any => ({ supplierName: 'A', reason: 'overstock', items: [{ variantId: vid, quantity: qty }] });

    it('a staff return above the approval bar is QUEUED (stock untouched); approving applies it once; a second approval is refused', async () => {
      const { vid } = await mkVariant(100);
      const queued: any = await returns.create(STORE, SELLER, big(vid), 'staff1', { role: 'staff', permissions: staffBase });
      expect(queued.pendingApproval).toBe(true);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(100);
      const approvalId = String(queued.data._id);
      expect((await inv.listApprovals(SELLER, STORE)).data.some((a: any) => String(a._id) === approvalId)).toBe(true);
      const res: any = await inv.approveRequest(SELLER, STORE, approvalId, SELLER, 'seller');
      expect(res.data.result.totalCredit).toBeGreaterThanOrEqual(0);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(75);
      await expect(inv.approveRequest(SELLER, STORE, approvalId, SELLER, 'seller')).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(75);
    });

    it('five managers approving the same request at once apply it exactly once', async () => {
      const { vid } = await mkVariant(100);
      const queued: any = await returns.create(STORE, SELLER, big(vid, 30), 'staff1', { role: 'staff', permissions: staffBase });
      const id = String(queued.data._id);
      const out = await Promise.allSettled(Array.from({ length: 5 }, () => inv.approveRequest(SELLER, STORE, id, SELLER, 'seller')));
      expect(out.filter((x) => x.status === 'fulfilled').length).toBe(1);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(70);
      expect(await r.supplierReturnModel.countDocuments({ 'items.variantId': vid })).toBe(1);
    });

    it('rejecting applies nothing; a request that can no longer be applied goes back to pending instead of being lost', async () => {
      const { vid } = await mkVariant(100);
      const rejected: any = await returns.create(STORE, SELLER, big(vid), 'staff1', { role: 'staff', permissions: staffBase });
      await inv.rejectRequest(SELLER, STORE, String(rejected.data._id), SELLER, 'seller', 'no');
      expect((await r.productVariantModel.findById(vid)).stock).toBe(100);
      const q: any = await returns.create(STORE, SELLER, big(vid, 40), 'staff1', { role: 'staff', permissions: staffBase });
      await r.productVariantModel.updateOne({ _id: vid }, { $set: { stock: 10 } }); // stock vanished meanwhile
      await expect(inv.approveRequest(SELLER, STORE, String(q.data._id), SELLER, 'seller')).rejects.toBeInstanceOf(BadRequestException);
      expect((await r.approvalRequestModel.findById(q.data._id)).status).toBe('pending'); // can be retried / rejected later
    });

    it('staff WITH inventory.approve and small returns are applied directly; staff without inventory.adjust are still refused', async () => {
      const { vid } = await mkVariant(100);
      const direct: any = await returns.create(STORE, SELLER, big(vid, 30), 's', { role: 'staff', permissions: [...staffBase, 'inventory.approve'] });
      expect(direct.pendingApproval).toBeUndefined();
      const small: any = await returns.create(STORE, SELLER, big(vid, 3), 's', { role: 'staff', permissions: staffBase });
      expect(small.pendingApproval).toBeUndefined();
      await expect(returns.create(STORE, SELLER, big(vid, 3), 's', { role: 'staff', permissions: ['purchase_orders.manage'] })).rejects.toBeInstanceOf(ForbiddenException);
      expect((await r.productVariantModel.findById(vid)).stock).toBe(100 - 30 - 3);
    });
  });

  describe('barcode / SKU lookup', () => {
    it('finds by barcode or SKU inside the store only; foreign stores are refused', async () => {
      const { vid } = await mkVariant(3, { barcode: '5901234123457' });
      const hit: any = await inv.lookupByCode(SELLER, STORE, '5901234123457');
      expect(hit.data[0].variantId).toBe(vid);
      expect(hit.data[0].available).toBe(3);
      const bySku: any = await inv.lookupByCode(SELLER, STORE, 'SKU-' + vid);
      expect(bySku.data).toHaveLength(1);
      expect((await inv.lookupByCode(SELLER, STORE, 'nope')).data).toHaveLength(0);
      await expect(inv.lookupByCode('someone-else', STORE, '5901234123457')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(inv.lookupByCode(SELLER, STORE, '  ')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
