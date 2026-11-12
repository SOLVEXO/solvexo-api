/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests: seller draft orders for a wholesale company (catalog prices, tax exemption, company buyer, terms on completion).
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-draft.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { DraftOrdersService } from '../draft-orders/draft-orders.service';
import { DraftOrderSchema } from '../draft-orders/schemas/draft-order.schema';
import { OrderSchema } from '../orders/schemas/order.schema';
import { ProductSchema } from '../products/schemas/product.schema';
import { ProductVariantSchema } from '../products/schemas/productVariant.schema';
import { StoreSchema } from '../store/schemas/store.schema';
import { B2BContextService } from './b2b-context.service';
import { B2BApplicationSchema, B2BBuyerSchema, B2BCatalogItemSchema, B2BCatalogSchema, B2BCompanySchema, B2BLocationSchema } from './b2b.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const oid = () => String(new Types.ObjectId());
const stub = (): any => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : jest.fn().mockResolvedValue(undefined)) });

d('Draft orders for a wholesale company on a real MongoDB', () => {
  let conn: Connection;
  let repos: any;
  let m: any;
  let svc: DraftOrdersService;
  const SELLER = oid();
  const STORE = oid();
  const OTHER = oid();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2bdraft_it_${Date.now()}` }).asPromise();
    m = {
      companies: conn.model('B2BCompany', B2BCompanySchema), locations: conn.model('B2BLocation', B2BLocationSchema), buyers: conn.model('B2BBuyer', B2BBuyerSchema),
      applications: conn.model('B2BApplication', B2BApplicationSchema), catalogs: conn.model('B2BCatalog', B2BCatalogSchema), items: conn.model('B2BCatalogItem', B2BCatalogItemSchema),
    };
    repos = {
      draftOrderModel: conn.model('DraftOrder', DraftOrderSchema), orderModel: conn.model('Order', OrderSchema), productModel: conn.model('Product', ProductSchema),
      productVariantModel: conn.model('ProductVariant', ProductVariantSchema), storeModel: conn.model('Store', StoreSchema),
      userModel: conn.model('User', new mongoose.Schema({}, { strict: false })), variantLocationStockModel: conn.model('VariantLocationStock', new mongoose.Schema({}, { strict: false })),
    };
    for (const s of [STORE, OTHER]) await repos.storeModel.collection.insertOne({ _id: new Types.ObjectId(s), slug: 's-' + s, sellerId: SELLER, baseCurrency: 'PKR', isDelete: false });
    const ctx = new B2BContextService(m.companies, m.locations, m.buyers, m.applications, m.catalogs, m.items);
    svc = new DraftOrdersService(
      { repositories: repos } as any, stub(), { buildSnapshots: jest.fn().mockResolvedValue([]) } as any, stub(), { get: () => undefined } as any, stub(), stub(), stub(), stub(), ctx,
    );
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const product = async (storeId: string, price = 100, stock = 50) => {
    const pid = new Types.ObjectId();
    await repos.productModel.collection.insertOne({ _id: pid, storeId, sellerId: SELLER, isDelete: false, status: 'active', type: 'physical', name: 'P' + pid, slug: 'p-' + pid, images: [] });
    const vid = new Types.ObjectId();
    await repos.productVariantModel.collection.insertOne({ _id: vid, productId: String(pid), storeId, sku: 'S' + vid, price, stock, committedStock: 0, damagedStock: 0, inTransitStock: 0, isDelete: false, options: [], unlimitedStock: false });
    return { pid: String(pid), vid: String(vid) };
  };
  const company = async (storeId: string, over: any = {}, catalog: any = { includeAllProducts: true, defaultAdjustmentPercent: -20 }) => {
    const buyerId = oid();
    await repos.userModel.collection.insertOne({ _id: new Types.ObjectId(buyerId), storeId, email: buyerId + '@acme.com', name: 'Buyer' });
    const cat: any = await m.catalogs.create({ storeId, name: 'C' + oid(), ...catalog });
    const co: any = await m.companies.create({ storeId, name: 'Co' + oid(), status: 'approved', catalogId: String(cat._id), paymentTerms: { type: 'net', netDays: 30 }, ...over });
    const loc: any = await m.locations.create({ storeId, companyId: String(co._id), name: 'HQ' });
    await m.buyers.create({ storeId, companyId: String(co._id), locationId: String(loc._id), userId: buyerId, email: buyerId + '@acme.com', role: 'location_admin' });
    return { companyId: String(co._id), buyerId, catalogId: String(cat._id) };
  };
  const dto = (p: { pid: string; vid: string }, over: any = {}) => ({ customerName: 'Acme', items: [{ productId: p.pid, variantId: p.vid, quantity: 10 }], ...over });

  it('prices the draft from the company catalog, ignores typed tax for a tax-exempt company, and uses the company buyer as the customer', async () => {
    const p = await product(STORE, 100);
    const c = await company(STORE, { taxExempt: true });
    const draft: any = await svc.create(STORE, SELLER, dto(p, { companyId: c.companyId, taxAmount: 99, poNumber: ' PO-3 ' }) as any);
    expect(draft.items[0].unitPrice).toBe(80);
    expect(draft).toMatchObject({ subtotal: 800, taxAmount: 0, total: 800, customerId: c.buyerId });
    expect(draft.b2b).toMatchObject({ companyId: c.companyId, poNumber: 'PO-3', taxExempt: true, paymentTerms: { type: 'net', netDays: 30 } });
    expect(draft.paymentTerms).toBeNull();
  });

  it('a typed unit price still wins; quantity rules and availability of the company catalog are enforced', async () => {
    const p = await product(STORE, 100); const hidden = await product(STORE, 100);
    const c = await company(STORE, {}, { includeAllProducts: true });
    await m.items.create({ storeId: STORE, catalogId: c.catalogId, productId: p.pid, variantId: p.vid, minQty: 12 });
    await m.items.create({ storeId: STORE, catalogId: c.catalogId, productId: hidden.pid, variantId: hidden.vid, available: false });
    await expect(svc.create(STORE, SELLER, dto(p, { companyId: c.companyId }) as any)).rejects.toThrow(/Minimum order quantity is 12/);
    await expect(svc.create(STORE, SELLER, dto(hidden, { companyId: c.companyId }) as any)).rejects.toThrow(/not available to your company/);
    const ok: any = await svc.create(STORE, SELLER, { customerName: 'Acme', companyId: c.companyId, items: [{ productId: p.pid, variantId: p.vid, quantity: 12, unitPrice: 55 }] } as any);
    expect(ok.items[0].unitPrice).toBe(55);
  });

  it('refuses a company of another store, an unapproved company, and a customer who is not one of its buyers', async () => {
    const p = await product(STORE);
    const foreign = await company(OTHER);
    const pending = await company(STORE, { status: 'pending' });
    const c = await company(STORE);
    await expect(svc.create(STORE, SELLER, dto(p, { companyId: foreign.companyId }) as any)).rejects.toThrow(/Company not found/);
    await expect(svc.create(STORE, SELLER, dto(p, { companyId: pending.companyId }) as any)).rejects.toThrow(/Company not found/);
    await expect(svc.create(STORE, SELLER, dto(p, { companyId: c.companyId, customerId: oid() }) as any)).rejects.toThrow(/not one of its buyers/);
    await expect(svc.create(STORE, SELLER, dto(p, { companyId: 'nope' }) as any)).rejects.toThrow(/Company not found/);
  });

  it('completing a company draft on terms places an unpaid terms order with the receivable, PO number and the stock taken', async () => {
    const p = await product(STORE, 100, 50);
    const c = await company(STORE, {}, { includeAllProducts: true, defaultAdjustmentPercent: -10 });
    const draft: any = await svc.create(STORE, SELLER, dto(p, { companyId: c.companyId, poNumber: 'PO-9' }) as any);
    const done = await svc.complete(STORE, SELLER, String(draft._id));
    const order: any = await repos.orderModel.collection.findOne({ _id: new Types.ObjectId(done.orderId) });
    expect(order).toMatchObject({ paymentType: 'b2b_terms', isPaid: false, totalAmount: 900, userId: c.buyerId });
    expect(order.b2b).toMatchObject({ companyId: c.companyId, poNumber: 'PO-9', total: 900, paidTotal: 0, status: 'unpaid', terms: { type: 'net', netDays: 30 } });
    expect(order.b2b.dueDate).toBeTruthy();
    expect(((await repos.productVariantModel.collection.findOne({ _id: new Types.ObjectId(p.vid) })) as any).stock).toBe(40);
  });

  it('a company without terms completes as a normal unpaid order but keeps company and PO number; a plain draft is untouched', async () => {
    const p = await product(STORE, 100, 50);
    const noTerms = await company(STORE, { paymentTerms: null });
    const d1: any = await svc.create(STORE, SELLER, dto(p, { companyId: noTerms.companyId, poNumber: 'PO-1' }) as any);
    const o1: any = await repos.orderModel.collection.findOne({ _id: new Types.ObjectId((await svc.complete(STORE, SELLER, String(d1._id))).orderId) });
    expect(o1.paymentType).toBe('manual_bank_transfer');
    expect(o1.b2b).toMatchObject({ companyId: noTerms.companyId, poNumber: 'PO-1', terms: null });

    const buyer = oid();
    await repos.userModel.collection.insertOne({ _id: new Types.ObjectId(buyer), storeId: STORE, email: 'retail@x.com' });
    const d2: any = await svc.create(STORE, SELLER, { customerId: buyer, customerName: 'Retail', items: [{ productId: p.pid, variantId: p.vid, quantity: 1 }] } as any);
    expect(d2.b2b).toBeNull();
    expect(d2.items[0].unitPrice).toBe(100);
    const o2: any = await repos.orderModel.collection.findOne({ _id: new Types.ObjectId((await svc.complete(STORE, SELLER, String(d2._id))).orderId) });
    expect(o2.b2b).toBeNull();
  });
});
