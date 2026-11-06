/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for B2BContextService (who is a wholesale buyer, server-side price / availability / quantity rules, applications).
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-context.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { B2BContextService } from './b2b-context.service';
import { PaymentService } from '../payment/payment.service';
import { B2BApplicationSchema, B2BBuyerSchema, B2BCatalogItemSchema, B2BCatalogSchema, B2BCompanySchema, B2BLocationSchema } from './b2b.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('B2BContextService on a real MongoDB', () => {
  let conn: Connection;
  let svc: B2BContextService;
  let m: any;
  const A = String(new Types.ObjectId());
  const B = String(new Types.ObjectId());
  const oid = () => String(new Types.ObjectId());

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2bctx_it_${Date.now()}` }).asPromise();
    m = {
      companies: conn.model('B2BCompany', B2BCompanySchema), locations: conn.model('B2BLocation', B2BLocationSchema), buyers: conn.model('B2BBuyer', B2BBuyerSchema),
      applications: conn.model('B2BApplication', B2BApplicationSchema), catalogs: conn.model('B2BCatalog', B2BCatalogSchema), items: conn.model('B2BCatalogItem', B2BCatalogItemSchema),
    };
    await Promise.all(Object.values(m).map((x: any) => x.init()));
    svc = new B2BContextService(m.companies, m.locations, m.buyers, m.applications, m.catalogs, m.items);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const seed = async (storeId: string, over: { company?: any; location?: any; buyer?: any; catalog?: any } = {}) => {
    const userId = oid();
    const catalog: any = over.catalog === null ? null : await m.catalogs.create({ storeId, name: 'C' + oid(), ...(over.catalog ?? {}) });
    const company: any = await m.companies.create({ storeId, name: 'Co' + oid(), status: 'approved', catalogId: catalog ? String(catalog._id) : null, ...(over.company ?? {}) });
    const location: any = await m.locations.create({ storeId, companyId: String(company._id), name: 'L', ...(over.location ?? {}) });
    await m.buyers.create({ storeId, companyId: String(company._id), locationId: String(location._id), userId, email: `${userId}@x.com`, role: 'ordering', ...(over.buyer ?? {}) });
    return { userId, company, location, catalog };
  };
  const item = (storeId: string, catalogId: string, variantId: string, extra: any = {}) => m.items.create({ storeId, catalogId, productId: oid(), variantId, ...extra });

  it('a visitor, a retail customer, a disabled buyer, and a buyer of a suspended/pending company all get retail rules (null)', async () => {
    expect(await svc.getContext(A, oid())).toBeNull();
    const disabled = await seed(A, { buyer: { status: 'disabled' } });
    expect(await svc.getContext(A, disabled.userId)).toBeNull();
    const suspended = await seed(A, { company: { status: 'suspended' } });
    expect(await svc.getContext(A, suspended.userId)).toBeNull();
    const pending = await seed(A, { company: { status: 'pending' } });
    expect(await svc.getContext(A, pending.userId)).toBeNull();
  });

  it('a wholesale buyer of store A is a plain customer in store B', async () => {
    const s = await seed(A);
    expect(await svc.getContext(A, s.userId)).not.toBeNull();
    expect(await svc.getContext(B, s.userId)).toBeNull();
  });

  it('server-side price: volume break > fixed > % > catalog default > retail, and retail stays retail without a catalog', async () => {
    const s = await seed(A, { catalog: { defaultAdjustmentPercent: -20, includeAllProducts: true } });
    const v1 = oid(); const v2 = oid(); const v3 = oid();
    await item(A, String(s.catalog._id), v1, { fixedPrice: 80, priceBreaks: [{ minQty: 10, price: 70 }] });
    await item(A, String(s.catalog._id), v2, { adjustmentPercent: -10 });
    const ctx: any = await svc.getContext(A, s.userId);
    const entries = await svc.loadEntries(ctx, [v1, v2, v3]);
    const price = (variantId: string, quantity: number) => svc.resolveLine(ctx, entries, { productName: 'P', variantId, basePrice: 100, quantity }).unitPrice;
    expect(price(v1, 1)).toBe(80);
    expect(price(v1, 10)).toBe(70);
    expect(price(v2, 1)).toBe(90);
    expect(price(v3, 1)).toBe(80); // not in the catalog but includeAllProducts: catalog default -20%

    const plain = await seed(A, { catalog: null });
    const pctx: any = await svc.getContext(A, plain.userId);
    expect(svc.resolveLine(pctx, new Map(), { productName: 'P', variantId: v1, basePrice: 100, quantity: 1 }).unitPrice).toBe(100);
  });

  it('a variant outside a restricted catalog, or marked unavailable, is refused with a readable error', async () => {
    const s = await seed(A, { catalog: { includeAllProducts: false } });
    const listed = oid(); const hidden = oid(); const missing = oid();
    await item(A, String(s.catalog._id), listed, { available: true });
    await item(A, String(s.catalog._id), hidden, { available: false });
    const ctx: any = await svc.getContext(A, s.userId);
    const entries = await svc.loadEntries(ctx, [listed, hidden, missing]);
    const line = (variantId: string) => () => svc.resolveLine(ctx, entries, { productName: 'Widget', variantId, basePrice: 10, quantity: 1 });
    expect(line(listed)).not.toThrow();
    expect(line(hidden)).toThrow(/not available to your company/);
    expect(line(missing)).toThrow(/not available to your company/);
  });

  it('quantity rules are enforced on the server (min, max, increment), falling back to the product fields', async () => {
    const s = await seed(A, { catalog: { includeAllProducts: true } });
    const v = oid(); const w = oid();
    await item(A, String(s.catalog._id), v, { minQty: 6, maxQty: 24, increment: 6 });
    const ctx: any = await svc.getContext(A, s.userId);
    const entries = await svc.loadEntries(ctx, [v, w]);
    const q = (variantId: string, quantity: number, product?: any) => () => svc.resolveLine(ctx, entries, { productName: 'Widget', product, variantId, basePrice: 10, quantity });
    expect(q(v, 12)).not.toThrow();
    expect(q(v, 3)).toThrow(/Minimum order quantity is 6/);
    expect(q(v, 30)).toThrow(/Maximum order quantity is 24/);
    expect(q(v, 13)).toThrow(/multiple of 6/);
    expect(q(w, 2, { orderMinQuantity: 5 })).toThrow(/Minimum order quantity is 5/);
    expect(q(w, 5, { orderMinQuantity: 5 })).not.toThrow();
  });

  it('a location overrides the company catalog, payment terms and methods', async () => {
    const companyCatalog: any = await m.catalogs.create({ storeId: A, name: 'CC' + oid() });
    const locationCatalog: any = await m.catalogs.create({ storeId: A, name: 'LC' + oid(), defaultAdjustmentPercent: -30, includeAllProducts: true });
    const s = await seed(A, {
      catalog: null,
      company: { catalogId: String(companyCatalog._id), paymentTerms: { type: 'net', netDays: 30 }, allowedPaymentMethods: ['bank_transfer'] },
      location: { catalogId: String(locationCatalog._id), paymentTerms: { type: 'due_on_order' }, allowedPaymentMethods: ['manual_bank_transfer'] },
    });
    const ctx: any = await svc.getContext(A, s.userId);
    expect(ctx.catalog.id).toBe(String(locationCatalog._id));
    const snap = svc.snapshot(ctx, '  PO-7  ');
    expect(snap.paymentTerms).toMatchObject({ type: 'due_on_order' });
    expect(snap.allowedPaymentMethods).toEqual(['manual_bank_transfer']);
    expect(snap.poNumber).toBe('PO-7');
  });

  it('a draft catalog is ignored (retail price), and a catalog of another store is never used', async () => {
    const draft = await seed(A, { catalog: { status: 'draft', defaultAdjustmentPercent: -50, includeAllProducts: true } });
    expect(((await svc.getContext(A, draft.userId)) as any).catalog).toBeNull();
    const foreign: any = await m.catalogs.create({ storeId: B, name: 'F' + oid(), defaultAdjustmentPercent: -50 });
    const s = await seed(A, { catalog: null, company: { catalogId: String(foreign._id) } });
    expect(((await svc.getContext(A, s.userId)) as any).catalog).toBeNull();
  });

  it('applications: one open per customer, refused for existing buyers, me() shows the right standing, rejected note is public-safe', async () => {
    const uid = oid();
    expect((await svc.me(A, uid)).status).toBe('none');
    await expect(svc.apply(A, { userId: uid, email: 'a@x.com' }, { companyName: '  ' })).rejects.toThrow(/Company name/);
    await svc.apply(A, { userId: uid, email: 'a@x.com' }, { companyName: 'Wholesale Ltd', taxId: 'NTN-1' });
    await expect(svc.apply(A, { userId: uid, email: 'a@x.com' }, { companyName: 'Again' })).rejects.toThrow(/already have a wholesale application/);
    expect((await svc.me(A, uid)).status).toBe('pending');
    expect((await svc.me(B, uid)).status).toBe('none'); // another store sees nothing

    await m.applications.updateOne({ storeId: A, userId: uid }, { $set: { status: 'rejected', decisionNote: 'Need a trade licence', companyId: null } });
    expect(await svc.me(A, uid)).toMatchObject({ status: 'rejected', decisionNote: 'Need a trade licence' });
    await svc.apply(A, { userId: uid, email: 'a@x.com' }, { companyName: 'Wholesale Ltd 2' }); // may re-apply after a rejection

    const buyer = await seed(A);
    await expect(svc.apply(A, { userId: buyer.userId, email: 'b@x.com' }, { companyName: 'X' })).rejects.toThrow(/already belongs/);
    expect(await svc.me(A, buyer.userId)).toMatchObject({ status: 'approved', role: 'ordering' });
  });

  it('payment method gate: allow-list blocks others, empty list allows all, store credit is never blocked', () => {
    expect(() => svc.assertPaymentMethodAllowed({ allowedPaymentMethods: ['manual_bank_transfer'] }, 'cash_on_delivery')).toThrow(/not available for your company/);
    expect(() => svc.assertPaymentMethodAllowed({ allowedPaymentMethods: ['manual_bank_transfer'] }, 'manual_bank_transfer')).not.toThrow();
    expect(() => svc.assertPaymentMethodAllowed({ allowedPaymentMethods: [] }, 'cash_on_delivery')).not.toThrow();
    expect(() => svc.assertPaymentMethodAllowed({ allowedPaymentMethods: ['manual_bank_transfer'] }, 'store_credit')).not.toThrow();
    expect(() => svc.assertPaymentMethodAllowed(null, 'stripe')).not.toThrow();
  });
});

describe('PaymentService.assertDiscountsStillValid enforces the company payment-method list', () => {
  const make = () => {
    const s: any = Object.create(PaymentService.prototype);
    s.assertCouponStillUsable = jest.fn().mockResolvedValue(undefined);
    s.assertStoreCreditStillCovers = jest.fn().mockResolvedValue(undefined);
    return s;
  };
  const checkout = { b2b: { allowedPaymentMethods: ['manual_bank_transfer'] } };
  it('blocks COD and card for a bank-transfer-only company, allows bank transfer and store credit', async () => {
    const s = make();
    await expect(s.assertDiscountsStillValid(checkout, 'cash_on_delivery')).rejects.toThrow(/not available for your company/);
    await expect(s.assertDiscountsStillValid(checkout, 'stripe')).rejects.toThrow(/not available for your company/);
    await expect(s.assertDiscountsStillValid(checkout, 'safepay')).rejects.toThrow(/not available for your company/);
    await expect(s.assertDiscountsStillValid(checkout, 'manual_bank_transfer')).resolves.toBeUndefined();
    await expect(s.assertDiscountsStillValid(checkout, 'store_credit')).resolves.toBeUndefined();
  });
  it('retail checkouts and callers without a method are unaffected', async () => {
    const s = make();
    await expect(s.assertDiscountsStillValid({ b2b: null }, 'cash_on_delivery')).resolves.toBeUndefined();
    await expect(s.assertDiscountsStillValid({}, 'stripe')).resolves.toBeUndefined();
    await expect(s.assertDiscountsStillValid(checkout)).resolves.toBeUndefined();
  });
});
