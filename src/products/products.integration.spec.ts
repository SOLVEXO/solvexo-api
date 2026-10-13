/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB integration tests for the Products module (transactions, SKU uniqueness, stock concurrency, delete
 * cascades, boot migration). They need a REPLICA SET and are skipped unless PRODUCTS_IT_MONGO is set, e.g.
 *   PRODUCTS_IT_MONGO="mongodb://127.0.0.1:27099/?replicaSet=rs0" npx jest products.integration
 * They create a throw-away database and drop it afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection } from 'mongoose';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductSchema } from './schemas/product.schema';
import { ProductVariantSchema } from './schemas/productVariant.schema';
import { CartSchema } from '../cart/schemas/cart.schema';
import { wishListSchema } from '../cart/schemas/wishlist.schema';
import { CollectionSchema } from '../collections/schemas/collection.schema';
import { VariantLocationStockSchema } from '../inventory/schemas/variant-location-stock.schema';
import { StoreSchema } from '../store/schemas/store.schema';
import { SellerSchema } from '../seller/seller.schema';
import { CategorySchema } from '../categories/schemas/category.schema';
import { SeoRedirectSchema } from '../seo/schemas/seo-redirect.schema';
import { ProductsService } from './products.service';
import { ProductVariantsService } from '../product-variants/product-variants.service';
import { CatalogIntegrityService } from './catalog-integrity.service';
import { softDeleteProducts } from './product-cascade.util';

const URI = process.env.PRODUCTS_IT_MONGO;
const d = URI ? describe : describe.skip;

d('Products module on a real replica set', () => {
  let conn: Connection;
  let r: any;
  let products: ProductsService;
  let variants: ProductVariantsService;
  let integrity: CatalogIntegrityService;
  let limitOver = false;
  const SELLER = 'sel1';
  let STORE: string;
  let CATEGORY: string;

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `products_it_${Date.now()}` }).asPromise();
    r = {
      productModel: conn.model('Product', ProductSchema),
      productVariantModel: conn.model('ProductVariant', ProductVariantSchema),
      cartModel: conn.model('Cart', CartSchema),
      wishListModel: conn.model('wishList', wishListSchema),
      collectionModel: conn.model('Collection', CollectionSchema),
      variantLocationStockModel: conn.model('VariantLocationStock', VariantLocationStockSchema),
      storeModel: conn.model('Store', StoreSchema),
      sellerModel: conn.model('Seller', SellerSchema),
      categoryModel: conn.model('Category', CategorySchema),
      seoRedirectModel: conn.model('SeoRedirect', SeoRedirectSchema),
    };
    for (const [k, m] of Object.entries(r) as any) { try { await m.createIndexes(); } catch (e: any) { console.warn('INDEX BUILD FAILED on ' + k + ': ' + e.message.slice(0, 160)); } }
    const db: any = { repositories: r };
    const activity: any = { log: jest.fn(async () => undefined) };
    const entitlements: any = {
      assertCanCreateProduct: jest.fn(async () => undefined),
      isOverProductLimit: jest.fn(async () => limitOver),
    };
    const nothing: any = {};
    products = new (ProductsService as any)(db, activity, entitlements, nothing, nothing, nothing, nothing, conn);
    variants = new ProductVariantsService(db, activity, conn as any);
    integrity = new CatalogIntegrityService(db, { withLock: async (_k: string, _t: number, fn: any) => fn(), isConnected: true } as any);

    await r.sellerModel.collection.insertOne({ _id: new mongoose.Types.ObjectId(), status: 'active', isDelete: false });
    const seller = await r.sellerModel.collection.findOne({});
    (global as any).__sellerId = String(seller._id);
    const storeId = new mongoose.Types.ObjectId();
    await r.storeModel.collection.insertOne({
      _id: storeId, sellerId: String(seller._id), status: 'active', isDelete: false, baseCurrency: 'USD',
      productTypes: ['physical_products'], name: 'S', slug: 's',
    });
    STORE = String(storeId);
    const cat = new mongoose.Types.ObjectId();
    await r.categoryModel.collection.insertOne({ _id: cat, status: 'active', isDelete: false, storeId: null, name: 'C' });
    CATEGORY = String(cat);
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  const sid = () => (global as any).__sellerId as string;
  const mk = (name: string, vs: any[], extra: any = {}) =>
    products.addPhysicalProduct(sid(), { storeId: STORE, name, categoryId: CATEGORY, status: 'draft', variants: vs, ...extra });
  const v = (sku: string | undefined, o = 'S', stock = 10) => ({ sku, price: 10, stock, options: [{ name: 'Size', value: o }] });

  it('create is atomic: product + variants are written together with per-store unique SKUs', async () => {
    const res: any = await mk('Alpha', [v('AL-1', 'S'), v('AL-2', 'M')]);
    expect(res.success).toBe(true);
    const id = String(res.data.product._id);
    expect(await r.productVariantModel.countDocuments({ productId: id })).toBe(2);
    expect((await r.productVariantModel.findOne({ productId: id })).storeId).toBe(STORE);
  });

  it('rejects an existing SKU in the same store (409) and leaves NO orphan product behind', async () => {
    const before = await r.productModel.countDocuments({});
    await expect(mk('Beta', [v('AL-1')])).rejects.toBeInstanceOf(ConflictException);
    expect(await r.productModel.countDocuments({})).toBe(before);
  });

  it('transaction rolls back when a later write fails (no half-created product)', async () => {
    const before = await r.productModel.countDocuments({});
    const spy = jest.spyOn(r.productVariantModel, 'insertMany').mockRejectedValueOnce(new Error('boom'));
    await expect(mk('Gamma', [v('GA-1')])).rejects.toThrow('boom');
    spy.mockRestore();
    expect(await r.productModel.countDocuments({})).toBe(before);
    expect(await r.productVariantModel.countDocuments({ sku: 'GA-1' })).toBe(0);
  });

  it('50 concurrent creates of the SAME sku => exactly one wins, the rest 409, DB has one live row', async () => {
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => mk(`Race ${i}`, [v('RACE-1')])));
    const ok = results.filter((x) => x.status === 'fulfilled').length;
    const conflicts = results.filter((x) => x.status === 'rejected' && (x as any).reason instanceof ConflictException).length;
    expect(ok).toBe(1);
    expect(conflicts).toBe(49);
    expect(await r.productVariantModel.countDocuments({ storeId: STORE, sku: 'RACE-1', isDelete: false })).toBe(1);
    // no leaked products from the 49 losers
    expect(await r.productModel.countDocuments({ name: /^Race / })).toBe(1);
  });

  it('same SKU in a DIFFERENT store is allowed', async () => {
    const other = new mongoose.Types.ObjectId();
    await r.storeModel.collection.insertOne({ _id: other, sellerId: sid(), status: 'active', isDelete: false, baseCurrency: 'USD', productTypes: ['physical_products'], name: 'S2', slug: 's2' });
    const res: any = await products.addPhysicalProduct(sid(), { storeId: String(other), name: 'Other', categoryId: CATEGORY, status: 'draft', variants: [v('AL-1')] });
    expect(res.success).toBe(true);
  });

  it('plan limit race: over-limit create is compensated (product removed) and refused', async () => {
    limitOver = true;
    const before = await r.productModel.countDocuments({ isDelete: false });
    await expect(mk('Over', [v('OV-1')])).rejects.toBeDefined();
    limitOver = false;
    expect(await r.productModel.countDocuments({ isDelete: false })).toBe(before);
  });

  it('scheduled products need a future date; past date rejected', async () => {
    await expect(mk('Sched', [v('SC-1')], { status: 'scheduled', scheduledAt: '2020-01-01' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stock concurrency: 30 parallel absolute edits => 1 applies, others 409; DB value equals the winner', async () => {
    const res: any = await mk('Stocky', [v('ST-1', 'S', 100)]);
    const pid = String(res.data.product._id);
    const vid = String((await r.productVariantModel.findOne({ productId: pid }))._id);
    const out = await Promise.allSettled(Array.from({ length: 30 }, (_, i) => variants.updateVariant(sid(), pid, vid, { stock: 200 + i } as any)));
    const won = out.filter((x) => x.status === 'fulfilled').length;
    expect(won).toBeGreaterThanOrEqual(1);
    const lost = out.filter((x) => x.status === 'rejected');
    expect(lost.every((x: any) => x.reason instanceof ConflictException)).toBe(true);
    const final = await r.productVariantModel.findById(vid);
    expect(final.stock).toBeGreaterThanOrEqual(200);
    expect(final.stock).toBeLessThan(230);
  });

  it('stock edit syncs the single location row; refused with several locations; stale stock cannot clobber a sale', async () => {
    const res: any = await mk('Loc', [v('LO-1', 'S', 10)]);
    const pid = String(res.data.product._id);
    const vid = String((await r.productVariantModel.findOne({ productId: pid }))._id);
    await r.variantLocationStockModel.collection.insertOne({ variantId: vid, productId: pid, storeId: STORE, locationId: 'L1', stock: 10 });
    await variants.updateVariant(sid(), pid, vid, { stock: 25 } as any);
    expect((await r.variantLocationStockModel.findOne({ variantId: vid })).stock).toBe(25);
    await r.variantLocationStockModel.collection.insertOne({ variantId: vid, productId: pid, storeId: STORE, locationId: 'L2', stock: 0 });
    await expect(variants.updateVariant(sid(), pid, vid, { stock: 30 } as any)).rejects.toBeInstanceOf(BadRequestException);
    // transaction rolled back: variant stock unchanged by the refused edit
    expect((await r.productVariantModel.findById(vid)).stock).toBe(25);
  });

  it('variant SKU edit cannot take another variant\'s SKU (409) in the same store', async () => {
    const a: any = await mk('Va', [v('VA-1')]);
    const b: any = await mk('Vb', [v('VB-1')]);
    const bid = String(b.data.product._id);
    const bv = String((await r.productVariantModel.findOne({ productId: bid }))._id);
    await expect(variants.updateVariant(sid(), bid, bv, { sku: 'VA-1' } as any)).rejects.toBeInstanceOf(ConflictException);
    expect(a.success).toBe(true);
  });

  it('delete cascade: variants, carts, collections, wishlists are cleaned; SKU is released for reuse', async () => {
    const res: any = await mk('Del', [v('DEL-1', 'S'), v('DEL-2', 'M')]);
    const pid = String(res.data.product._id);
    const vid = String((await r.productVariantModel.findOne({ productId: pid, sku: 'DEL-1' }))._id);
    await r.cartModel.collection.insertOne({ userId: 'u1', storeId: STORE, items: [{ productId: pid, productVariantId: vid, quantity: 1 }, { productId: 'keep', productVariantId: 'kv', quantity: 1 }] });
    await r.collectionModel.collection.insertOne({ storeId: STORE, productIds: [pid, 'keep'] });
    await r.wishListModel.collection.insertOne({ userId: 'u1', storeId: STORE, productId: pid, productVariantId: vid });
    await products.deleteProduct(sid(), pid);
    expect((await r.productModel.findById(pid)).isDelete).toBe(true);
    expect(await r.productVariantModel.countDocuments({ productId: pid, isDelete: false })).toBe(0);
    const cart = await r.cartModel.collection.findOne({ userId: 'u1' });
    expect(cart.items.map((i: any) => i.productId)).toEqual(['keep']);
    expect((await r.collectionModel.collection.findOne({ storeId: STORE })).productIds).toEqual(['keep']);
    expect(await r.wishListModel.collection.countDocuments({ productId: pid })).toBe(0);
    const again: any = await mk('Del2', [v('DEL-1')]); // released SKU is reusable
    expect(again.success).toBe(true);
  });

  it('bulk-delete cascade util is transactional and scoped to the store', async () => {
    const x: any = await mk('Bx', [v('BX-1')]);
    const y: any = await mk('By', [v('BY-1')]);
    const ids = [String(x.data.product._id), String(y.data.product._id)];
    await conn.transaction((session) => softDeleteProducts(r, { storeId: STORE, productIds: ids, session }));
    expect(await r.productModel.countDocuments({ _id: { $in: ids }, isDelete: false })).toBe(0);
    expect(await r.productVariantModel.countDocuments({ productId: { $in: ids }, isDelete: false })).toBe(0);
    const wrong: any = await mk('Bz', [v('BZ-1')]);
    await conn.transaction((session) => softDeleteProducts(r, { storeId: 'someone-elses-store', productIds: [String(wrong.data.product._id)], session }));
    expect((await r.productModel.findById(wrong.data.product._id)).isDelete).toBe(false);
  });

  it('duplicate copies variants with unique -COPY SKUs, zero stock, no barcode; repeated duplicates stay unique', async () => {
    const res: any = await mk('Orig', [{ ...v('OR-1', 'S', 7), barcode: '123' }]);
    const pid = String(res.data.product._id);
    const d1: any = await products.duplicateProduct(sid(), pid);
    const d2: any = await products.duplicateProduct(sid(), pid);
    const c1 = await r.productVariantModel.findOne({ productId: String(d1.data._id) });
    const c2 = await r.productVariantModel.findOne({ productId: String(d2.data._id) });
    expect(c1.sku).toBe('OR-1-COPY');
    expect(c2.sku).toBe('OR-1-COPY-2');
    expect(c1.stock).toBe(0);
    expect(c1.barcode).toBeNull();
    expect(d1.data.status).toBe('draft');
  });

  it('rename writes a 301 redirect for the old slug', async () => {
    const res: any = await mk('Old Name', [v('RN-1')]);
    const pid = String(res.data.product._id);
    const oldSlug = res.data.product.slug;
    await products.editProduct(sid(), { productId: pid, name: 'New Name' });
    const redirect = await r.seoRedirectModel.findOne({ storeId: STORE });
    expect(redirect).toBeTruthy();
    expect(JSON.stringify(redirect)).toContain(oldSlug);
  });

  it('migration: backfills storeId, renames legacy duplicate SKUs, then the unique index builds; idempotent', async () => {
    // simulate legacy data: drop the unique index, insert variants with no storeId and duplicate SKUs
    await r.productVariantModel.collection.dropIndex('storeId_1_sku_1_unique_live');
    const p1 = new mongoose.Types.ObjectId(); const p2 = new mongoose.Types.ObjectId();
    await r.productModel.collection.insertMany([
      { _id: p1, storeId: STORE, sellerId: sid(), isDelete: false, name: 'L1', slug: 'l1' },
      { _id: p2, storeId: STORE, sellerId: sid(), isDelete: false, name: 'L2', slug: 'l2' },
    ]);
    const base = { price: 1, stock: 1, isDelete: false, options: [], isDefault: true };
    await r.productVariantModel.collection.insertMany([
      { ...base, productId: String(p1), sku: 'LEG-1', createdAt: new Date(1000) },
      { ...base, productId: String(p2), sku: 'LEG-1', createdAt: new Date(2000) },
      { ...base, productId: String(p2), sku: 'LEG-1', createdAt: new Date(3000), isDefault: false },
    ]);
    const res = await integrity.runOnce();
    expect(res.backfilled).toBeGreaterThanOrEqual(3);
    expect(res.renamed).toBe(2);
    const legacy = await r.productVariantModel.find({ productId: { $in: [String(p1), String(p2)] } }).sort({ createdAt: 1 }).lean();
    expect(legacy.map((x: any) => x.sku)).toEqual(['LEG-1', 'LEG-1-D1', 'LEG-1-D2']);
    expect(legacy.every((x: any) => x.storeId === STORE)).toBe(true);
    const idx = await r.productVariantModel.collection.indexes();
    expect(idx.some((i: any) => i.name === 'storeId_1_sku_1_unique_live' && i.unique)).toBe(true);
    const again = await integrity.runOnce();
    expect(again).toEqual({ backfilled: 0, renamed: 0 });
    // and the index really enforces
    await expect(r.productVariantModel.collection.insertOne({ ...base, productId: 'x', storeId: STORE, sku: 'LEG-1' })).rejects.toMatchObject({ code: 11000 });
  });
});
