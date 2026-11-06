/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for the storefront B2B endpoints (prices, quick order) and the checkout PO-number endpoint.
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-storefront.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { B2BContextService } from './b2b-context.service';
import { B2BStorefrontController } from './b2b-storefront.controller';
import { CheckoutService } from '../checkout/checkout.service';
import { CheckoutSchema } from '../checkout/checkout.schema';
import { ProductSchema } from '../products/schemas/product.schema';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { B2BApplicationSchema, B2BBuyerSchema, B2BCatalogItemSchema, B2BCatalogSchema, B2BCompanySchema, B2BLocationSchema } from './b2b.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());

d('B2B storefront endpoints on a real MongoDB', () => {
  let conn: Connection;
  let m: any;
  let ctl: B2BStorefrontController;
  const A = oid();
  const B = oid();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2bsf_it_${Date.now()}` }).asPromise();
    m = {
      companies: conn.model('B2BCompany', B2BCompanySchema), locations: conn.model('B2BLocation', B2BLocationSchema), buyers: conn.model('B2BBuyer', B2BBuyerSchema),
      applications: conn.model('B2BApplication', B2BApplicationSchema), catalogs: conn.model('B2BCatalog', B2BCatalogSchema), items: conn.model('B2BCatalogItem', B2BCatalogItemSchema),
      products: conn.model('Product', ProductSchema), variants: conn.model('ProductVariant', ProductVariantSchema), checkouts: conn.model('Checkout', CheckoutSchema),
      users: conn.model('User', new mongoose.Schema({}, { strict: false })), stores: conn.model('Store', new mongoose.Schema({}, { strict: false })),
    };
    const ctx = new B2BContextService(m.companies, m.locations, m.buyers, m.applications, m.catalogs, m.items);
    ctl = new B2BStorefrontController(ctx, { repositories: { productModel: m.products, productVariantModel: m.variants, userModel: m.users, storeModel: m.stores } } as any);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const product = async (storeId: string, sku: string, price = 100, extra: any = {}) => {
    const pid = new Types.ObjectId();
    await m.products.collection.insertOne({ _id: pid, storeId, sellerId: 's', isDelete: false, status: 'active', type: 'physical', name: 'Prod ' + sku, slug: 'p-' + pid, ...extra });
    const vid = new Types.ObjectId();
    await m.variants.collection.insertOne({ _id: vid, productId: String(pid), storeId, sku, price, stock: 50, isDelete: false });
    return { pid: String(pid), vid: String(vid) };
  };
  const buyer = async (storeId: string, catalogItems: (cid: string) => Promise<void>, catalog: any = { includeAllProducts: true, defaultAdjustmentPercent: -20 }) => {
    const userId = oid();
    const cat: any = await m.catalogs.create({ storeId, name: 'C' + oid(), ...catalog });
    const co: any = await m.companies.create({ storeId, name: 'Co' + oid(), status: 'approved', catalogId: String(cat._id) });
    const loc: any = await m.locations.create({ storeId, companyId: String(co._id), name: 'L' });
    await m.buyers.create({ storeId, companyId: String(co._id), locationId: String(loc._id), userId, email: userId + '@x.com' });
    await catalogItems(String(cat._id));
    return { user: { userId, storeId }, req: { user: { userId, storeId } } as any };
  };

  it('prices: wholesale price, rule error and retail fallback per line, server-side', async () => {
    const p1 = await product(A, 'PR-1'); const p2 = await product(A, 'PR-2');
    const b = await buyer(A, async (cid) => { await m.items.create({ storeId: A, catalogId: cid, productId: p1.pid, variantId: p1.vid, fixedPrice: 70, minQty: 6, increment: 6 }); });
    const res: any = await ctl.prices(b.req, { lines: [{ variantId: p1.vid, quantity: 12 }, { variantId: p1.vid, quantity: 3 }, { variantId: p2.vid, quantity: 1 }] });
    expect(res.b2b).toBe(true);
    expect(res.lines[0]).toMatchObject({ available: true, unitPrice: 70, retailPrice: 100 });
    expect(res.lines[1]).toMatchObject({ available: false, suggested: 6 });
    expect(res.lines[1].error).toMatch(/Minimum order quantity is 6/);
    expect(res.lines[2]).toMatchObject({ available: true, unitPrice: 80 }); // catalog default -20%
  });

  it('prices: a retail customer or visitor gets b2b:false, and another store\'s variants are "Not available"', async () => {
    const p = await product(A, 'PR-3'); const other = await product(B, 'PR-3');
    expect(await ctl.prices({ user: { userId: oid(), storeId: A } } as any, { lines: [{ variantId: p.vid, quantity: 1 }] })).toEqual({ b2b: false, lines: [] });
    const b = await buyer(A, async () => undefined);
    const res: any = await ctl.prices(b.req, { lines: [{ variantId: other.vid, quantity: 1 }] });
    expect(res.lines[0]).toMatchObject({ available: false, error: 'Not available' });
    await expect(ctl.prices(b.req, { lines: [] })).rejects.toThrow(/between 1 and 50/);
    await expect(ctl.prices(b.req, { lines: [{ variantId: 'nope', quantity: 1 }] })).rejects.toThrow(/Invalid variant/);
  });

  it('quick order: resolves SKUs of THIS store with wholesale prices; reports bad SKU, bad quantity and rule breaks per line', async () => {
    const mine = await product(A, 'QO-1'); await product(B, 'QO-ONLY-B');
    const b = await buyer(A, async (cid) => { await m.items.create({ storeId: A, catalogId: cid, productId: mine.pid, variantId: mine.vid, fixedPrice: 60, minQty: 10 }); });
    const res: any = await ctl.quickOrder(b.req, { lines: [{ sku: 'QO-1', quantity: 10 }, { sku: 'QO-1', quantity: 2 }, { sku: 'QO-ONLY-B', quantity: 1 }, { sku: 'NOPE', quantity: 1 }, { sku: 'QO-1', quantity: 0 }, { sku: '', quantity: 1 }] });
    expect(res.lines[0]).toMatchObject({ ok: true, unitPrice: 60, productId: mine.pid, variantId: mine.vid });
    expect(res.lines[1]).toMatchObject({ ok: false, suggested: 10 });
    expect(res.lines[2]).toMatchObject({ ok: false, error: 'SKU not found' });
    expect(res.lines[3]).toMatchObject({ ok: false, error: 'SKU not found' });
    expect(res.lines[4].ok).toBe(false);
    expect(res.lines[5].ok).toBe(false);
  });

  it('quick order: refused for non-wholesale accounts and over 100 lines; archived products are not found', async () => {
    const arch = await product(A, 'QO-ARCH', 10, { status: 'inactive' });
    expect(arch.pid).toBeTruthy();
    await expect(ctl.quickOrder({ user: { userId: oid(), storeId: A } } as any, { lines: [{ sku: 'QO-ARCH', quantity: 1 }] })).rejects.toThrow(/approved wholesale/);
    const b = await buyer(A, async () => undefined);
    const res: any = await ctl.quickOrder(b.req, { lines: [{ sku: 'QO-ARCH', quantity: 1 }] });
    expect(res.lines[0]).toMatchObject({ ok: false, error: 'SKU not found' });
    await expect(ctl.quickOrder(b.req, { lines: Array.from({ length: 101 }, () => ({ sku: 'x', quantity: 1 })) })).rejects.toThrow(/between 1 and 100/);
  });

  describe('checkout PO number', () => {
    const svc: any = Object.create(CheckoutService.prototype);
    beforeAll(() => { svc.databaseService = { repositories: { checkoutModel: null } }; });
    const make = async (b2b: any, status = 'pending') => {
      const userId = oid();
      const _id = new Types.ObjectId();
      await m.checkouts.collection.insertOne({ _id, userId, status, isDelete: false, expiredAt: new Date(Date.now() + 600_000), b2b });
      svc.databaseService.repositories.checkoutModel = m.checkouts;
      return { userId, checkoutId: String(_id), _id };
    };
    it('saves, trims and clears the PO number for a wholesale checkout', async () => {
      const c = await make({ companyId: 'c1', poNumber: null });
      await svc.setB2BPoNumber(c.userId, { checkoutId: c.checkoutId, poNumber: '  PO-77  ' });
      expect(((await m.checkouts.collection.findOne({ _id: c._id })) as any).b2b.poNumber).toBe('PO-77');
      await svc.setB2BPoNumber(c.userId, { checkoutId: c.checkoutId, poNumber: '' });
      expect(((await m.checkouts.collection.findOne({ _id: c._id })) as any).b2b.poNumber).toBeNull();
    });
    it('refuses retail checkouts, other buyers\' checkouts, non-text values and finished checkouts', async () => {
      const retail = await make(null);
      await expect(svc.setB2BPoNumber(retail.userId, { checkoutId: retail.checkoutId, poNumber: 'x' })).rejects.toThrow(/only for wholesale/);
      const c = await make({ companyId: 'c1' });
      await expect(svc.setB2BPoNumber(oid(), { checkoutId: c.checkoutId, poNumber: 'x' })).rejects.toThrow(/not found/i);
      await expect(svc.setB2BPoNumber(c.userId, { checkoutId: c.checkoutId, poNumber: { $gt: '' } })).rejects.toThrow(/must be text/);
      const done = await make({ companyId: 'c1' }, 'completed');
      await expect(svc.setB2BPoNumber(done.userId, { checkoutId: done.checkoutId, poNumber: 'x' })).rejects.toThrow(/already completed/);
    });
  });
});
