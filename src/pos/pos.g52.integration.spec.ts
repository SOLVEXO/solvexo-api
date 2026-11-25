/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosProductEditService, detectImageMime, thumbUrl } from './pos-product-edit.service';
import { PosStoreSettingsService } from './pos-store-settings.service';
import { CostVisibilityInterceptor } from './cost-visibility.interceptor';
import { PosSupplyService } from './pos-supply.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import * as schema from '@/database/schema';
import { PurchaseOrderSchema } from '../purchase-orders/schemas/purchase-order.schema';
import { SupplierSchema } from '../purchase-orders/schemas/supplier.schema';
import { StockAdjustmentSchema } from '../inventory/schemas/stock-adjustment.schema';
import { StockLotSchema } from '../inventory/schemas/stock-lot.schema';
import { StockUnitSchema } from '../inventory/schemas/stock-unit.schema';

/** G5.2 on a real replica-set MongoDB: the product page at the till and editing an existing product (details, variant SKU / cost / reorder point, photos). */
jest.setTimeout(300_000);
let h: MongoHarness; let r: any; let edit: PosProductEditService; let supply: PosSupplyService; let st: PosStoreSettingsService; let costs: CostVisibilityInterceptor;
const uploads: any[] = [];
const fakeUpload: any = { uploadFile: jest.fn(async (f: any, o: any) => { uploads.push({ mimetype: f.mimetype, ...o }); return { url: `https://res.cloudinary.com/demo/image/upload/v1/products/p${uploads.length}.jpg`, publicId: `p${uploads.length}`, resourceType: 'image' }; }) };
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  const c = h.conn;
  Object.assign(h.repos, {
    purchaseOrderModel: c.model('PurchaseOrder', PurchaseOrderSchema), supplierModel: c.model('Supplier', SupplierSchema),
    purchaseReceiptModel: c.model(schema.PurchaseReceipt.name, schema.PurchaseReceiptSchema), supplierLedgerEntryModel: c.model(schema.SupplierLedgerEntry.name, schema.SupplierLedgerEntrySchema),
    stockAdjustmentModel: c.model('StockAdjustment', StockAdjustmentSchema), stockLotModel: c.model('StockLot', StockLotSchema), stockUnitModel: c.model('StockUnit', StockUnitSchema),
  });
  r = h.repos;
  await Promise.all(['purchaseReceiptModel', 'supplierLedgerEntryModel', 'stockUnitModel', 'posSettingsModel'].map((k) => r[k].init()));
  const dbs: any = { repositories: r };
  const pos = new PosService(dbs, { log: jest.fn().mockResolvedValue(undefined) } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
  const auth = new PosAuthorizer(dbs, pos);
  edit = new PosProductEditService(dbs, pos, auth, fakeUpload);
  st = new PosStoreSettingsService(dbs, pos, auth);
  costs = new CostVisibilityInterceptor(dbs, auth);
  supply = new PosSupplyService(dbs, pos, auth, { ensureLocationStockSeeded: jest.fn() } as any, {} as any);
});
afterAll(async () => { await h?.stop(); });
type Seed = Awaited<ReturnType<typeof seedStore>>;
const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
const dev = (s: Seed, who: 'manager' | 'cashier' = 'manager') => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } }, headers: { 'x-pos-employee-token': tok(s, who) }, params: { storeId: s.storeId }, query: {} });
const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' }, headers: {}, params: { storeId: s.storeId }, query: {} });
const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message; } };
const M = (s: Seed) => ({ employee: tok(s, 'manager') });
const C = (s: Seed) => ({ employee: tok(s, 'cashier') });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const file = (b: Buffer) => ({ buffer: b, size: b.length, originalname: 'x.bin', mimetype: 'application/octet-stream' }) as any;

describe('G5.2 · product page and editing an existing product', () => {
  it('the product page: details, variants with price, stock; a cashier sees it without cost and cannot edit', async () => {
    const s = await seedStore(h, { stock: 7, price: 12, baseCurrency: 'USD' });
    await r.productVariantModel.updateOne({ _id: s.variantId }, { $set: { costPriceMinor: 450, costPrice: 4.5 } });
    const m: any = (await edit.view(dev(s), s.storeId, s.productId, M(s))).data;
    expect([m.currency, m.currencyExponent, m.canEdit, m.product.variants[0].priceMinor, m.product.variants[0].costMinor, m.product.variants[0].stock]).toEqual(['USD', 2, true, 1200, 450, 7]);
    const c: any = (await edit.view(dev(s, 'cashier'), s.storeId, s.productId, C(s))).data;
    expect([c.canEdit, 'costMinor' in c.product.variants[0]]).toEqual([false, false]);
    expect(await code(edit.update(dev(s, 'cashier'), s.storeId, s.productId, { name: 'X' }, C(s)))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(edit.view(dev(s), s.storeId, String(new Types.ObjectId()), M(s)))).toBe('PRODUCT_NOT_FOUND');
  });

  it('a manager edits name / description / status, audited with before / after; empty name refused; nothing changed = no audit row', async () => {
    const s = await seedStore(h, { stock: 1, price: 5 });
    const d: any = (await edit.update(dev(s), s.storeId, s.productId, { name: 'Green tea 100g', description: 'Loose leaf', status: 'draft' }, M(s))).data;
    expect([d.product.name, d.product.description, d.product.status]).toEqual(['Green tea 100g', 'Loose leaf', 'draft']);
    const au: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'product_updated' }).lean();
    expect(au.metadata.after).toEqual({ name: 'Green tea 100g', description: 'Loose leaf', status: 'draft' });
    expect(await code(edit.update(dev(s), s.storeId, s.productId, { name: '  ' }, M(s)))).toBe('NAME_REQUIRED');
    await edit.update(dev(s), s.storeId, s.productId, { name: 'Green tea 100g' }, M(s));
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'product_updated' })).toBe(1);
  });

  it('variant SKU (unique), cost (minor), reorder point — audited; with "hide costs" a manager cannot change cost but the owner can, and the view drops cost for the manager', async () => {
    const s = await seedStore(h, { stock: 3, price: 10, baseCurrency: 'PKR' });
    const v: any = (await edit.updateVariant(dev(s), s.storeId, s.productId, s.variantId, { sku: 'TEA-100', costMinor: 52000, reorderPoint: 4 }, M(s))).data.product.variants[0];
    expect([v.sku, v.costMinor, v.reorderPoint]).toEqual(['TEA-100', 52000, 4]);
    expect((await r.productVariantModel.findById(s.variantId).lean()).costPrice).toBe(520);
    expect(await code(edit.updateVariant(dev(s), s.storeId, s.productId, s.variantId, { costMinor: 1.5 }, M(s)))).toBe('INVALID_AMOUNT');
    await st.update(owner(s) as any, s.storeId, { security: { hideCostsFromManagers: true } }, {});
    expect(await code(edit.updateVariant(dev(s), s.storeId, s.productId, s.variantId, { costMinor: 1 }, M(s)))).toBe('COSTS_HIDDEN');
    expect((await edit.updateVariant(owner(s) as any, s.storeId, s.productId, s.variantId, { costMinor: 53000 }, {})).data.product.variants[0].costMinor).toBe(53000);
    const raw: any = await edit.view(dev(s), s.storeId, s.productId, M(s));
    const hidden: any = await costs.apply(dev(s), `/api/pos/catalog-admin/products/${s.storeId}/${s.productId}`, raw);
    expect(['costMinor' in hidden.data.product.variants[0], hidden.data.costsHidden]).toEqual([false, true]);
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'variant_updated' })).toBe(2);
  });

  it('photos: by content only (JPEG / PNG / WebP), resized on upload, thumbnail URL, remove and make primary — audited', async () => {
    const s = await seedStore(h, { stock: 1, price: 5 });
    expect(await code(edit.addImage(dev(s), s.storeId, s.productId, file(Buffer.from('%PDF-1.7 not an image')), M(s)))).toBe('FILE_TYPE');
    let d: any = (await edit.addImage(dev(s), s.storeId, s.productId, file(PNG), M(s))).data;
    d = (await edit.addImage(dev(s), s.storeId, s.productId, file(PNG), M(s))).data;
    expect(uploads.at(-1)).toMatchObject({ mimetype: 'image/png', maxDimension: 1600, folder: `products/${s.storeId}` });
    const [a, b] = d.product.images;
    expect(a.thumbUrl).toContain('/image/upload/c_fill,w_240,h_240,q_auto,f_auto/');
    d = (await edit.primaryImage(dev(s), s.storeId, s.productId, { url: b.url }, M(s))).data;
    expect(d.product.images[0].url).toBe(b.url);
    d = (await edit.removeImage(dev(s), s.storeId, s.productId, { url: a.url }, M(s))).data;
    expect(d.product.images.map((x: any) => x.url)).toEqual([b.url]);
    expect(await code(edit.removeImage(dev(s), s.storeId, s.productId, { url: 'https://x/y.jpg' }, M(s)))).toBe('IMAGE_NOT_FOUND');
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: { $in: ['product_image_added', 'product_image_removed', 'product_image_primary'] } })).toBe(4);
  });

  it('helpers: image detection and thumbnails', () => {
    expect([detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), detectImageMime(Buffer.from('RIFF0000WEBPVP8 ')), detectImageMime(Buffer.from('GIF89a'))]).toEqual(['image/jpeg', 'image/webp', null]);
    expect(thumbUrl('https://example.com/a.jpg')).toBe('https://example.com/a.jpg');
  });

  it('serial-tracked items are received at the till: one serial per unit, unique, none on record; an older till (no serialNumbers) keeps SERIALS_NOT_SUPPORTED', async () => {
    const s = await seedStore(h, { stock: 0, price: 50, baseCurrency: 'USD' });
    await r.productVariantModel.updateOne({ _id: s.variantId }, { $set: { trackSerials: true } });
    const sup = new Types.ObjectId();
    await r.supplierModel.collection.insertOne({ _id: sup, storeId: s.storeId, sellerId: s.sellerId, name: 'Phones Ltd', status: 'active', isDelete: false });
    const recv = (line: any, rid = String(new Types.ObjectId())) => supply.receive(dev(s), s.storeId, { supplierId: String(sup), requestId: rid, lines: [{ variantId: s.variantId, unitCostMinor: 1000, ...line }] }, M(s));
    expect(await code(recv({ qtyGood: 2 }))).toBe('SERIALS_NOT_SUPPORTED');
    expect(await code(recv({ qtyGood: 2, serialNumbers: ['SN1'] }))).toBe('SERIALS_REQUIRED');
    expect(await code(recv({ qtyGood: 2, serialNumbers: ['SN1', 'SN1'] }))).toBe('SERIAL_DUPLICATE');
    const ok: any = (await recv({ qtyGood: 2, qtyDamaged: 1, serialNumbers: ['SN1', 'SN2', 'SN3'] })).data;
    expect(ok.receipt.lines[0]).toMatchObject({ qtyGood: 2, qtyDamaged: 1 });
    const units: any[] = await r.stockUnitModel.find({ variantId: s.variantId }).sort({ serialNumber: 1 }).lean();
    expect(units.map((u) => `${u.serialNumber}:${u.status}`)).toEqual(['SN1:in_stock', 'SN2:in_stock', 'SN3:damaged']);
    expect(await code(recv({ qtyGood: 1, serialNumbers: ['SN2'] }))).toBe('SERIAL_EXISTS');
    expect((await r.purchaseReceiptModel.findOne({ storeId: s.storeId }).lean()).lines[0].serialNumbers).toEqual(['SN1', 'SN2', 'SN3']);
  });
});
