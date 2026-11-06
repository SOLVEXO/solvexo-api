/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for the seller B2B admin service (tenant isolation, atomic approval, catalog rules).
 * Skipped unless MONGO_TEST_URI is set, e.g.
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit b2b-admin.integration
 * Uses a throw-away database that is dropped afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection, Types } from 'mongoose';
import { B2BAdminService } from './b2b-admin.service';
import {
  B2BApplicationSchema, B2BBuyerSchema, B2BCatalogItemSchema, B2BCatalogSchema, B2BCompanySchema, B2BLocationSchema,
} from './b2b.schema';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const actor = { id: 'seller-1', role: 'seller' };

d('B2BAdminService on a real MongoDB', () => {
  let conn: Connection;
  let svc: B2BAdminService;
  let m: any;
  const STORE_A = String(new Types.ObjectId());
  const STORE_B = String(new Types.ObjectId());

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `b2b_it_${Date.now()}` }).asPromise();
    m = {
      companies: conn.model('B2BCompany', B2BCompanySchema),
      locations: conn.model('B2BLocation', B2BLocationSchema),
      buyers: conn.model('B2BBuyer', B2BBuyerSchema),
      applications: conn.model('B2BApplication', B2BApplicationSchema),
      catalogs: conn.model('B2BCatalog', B2BCatalogSchema),
      items: conn.model('B2BCatalogItem', B2BCatalogItemSchema),
      users: conn.model('User', new mongoose.Schema({}, { strict: false })),
      variants: conn.model('ProductVariant', new mongoose.Schema({}, { strict: false })),
    };
    await Promise.all(Object.values(m).map((x: any) => x.init()));
    const db: any = { repositories: { userModel: m.users, productVariantModel: m.variants } };
    svc = new B2BAdminService(m.companies, m.locations, m.buyers, m.applications, m.catalogs, m.items, db, { log: jest.fn().mockResolvedValue(undefined) } as any);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const mkUser = async (storeId: string, email: string) => String((await m.users.collection.insertOne({ storeId, email, isDelete: false, tags: [] })).insertedId);

  it('a company gets a main location and cannot be read, changed or deleted from another store', async () => {
    const c: any = await svc.createCompany(STORE_A, actor, { name: 'Acme Traders', paymentTerms: { type: 'net', netDays: 30 } });
    const detail = await svc.getCompany(STORE_A, String(c._id));
    expect(detail.locations).toHaveLength(1);

    await expect(svc.getCompany(STORE_B, String(c._id))).rejects.toThrow(/not found/i);
    await expect(svc.updateCompany(STORE_B, actor, String(c._id), { name: 'Hacked' })).rejects.toThrow(/not found/i);
    await expect(svc.deleteCompany(STORE_B, actor, String(c._id))).rejects.toThrow(/not found/i);
    expect((await svc.listCompanies(STORE_B, {})).total).toBe(0);
    expect((await svc.getCompany(STORE_A, String(c._id))).company.name).toBe('Acme Traders');
  });

  it('rejects bad terms, duplicate names and unknown catalogs; ignores unknown fields (no mass assignment)', async () => {
    await expect(svc.createCompany(STORE_A, actor, { name: 'X', paymentTerms: { type: 'net', netDays: 45 } })).rejects.toThrow(/Net terms/);
    await svc.createCompany(STORE_A, actor, { name: 'Dup Co' });
    await expect(svc.createCompany(STORE_A, actor, { name: 'Dup Co' })).rejects.toThrow(/already exists/);
    await expect(svc.createCompany(STORE_A, actor, { name: 'Bad Catalog', catalogId: String(new Types.ObjectId()) })).rejects.toThrow(/Catalog not found/);
    const c: any = await svc.createCompany(STORE_A, actor, { name: 'Safe Co', storeId: STORE_B, _id: String(new Types.ObjectId()), isDelete: true });
    expect(c.storeId).toBe(STORE_A);
    expect(c.isDelete).toBe(false);
  });

  it('a buyer must be a customer of THIS store, belongs to one location only, and gets the b2b tag', async () => {
    const c: any = await svc.createCompany(STORE_A, actor, { name: 'Buyer Co' });
    const loc: any = (await svc.getCompany(STORE_A, String(c._id))).locations[0];
    const otherStoreUser = await mkUser(STORE_B, 'x@other.com');
    expect(otherStoreUser).toBeTruthy();
    await expect(svc.addBuyer(STORE_A, actor, String(loc._id), { email: 'x@other.com' })).rejects.toThrow(/No customer/);

    const uid = await mkUser(STORE_A, 'buyer@a.com');
    const b: any = await svc.addBuyer(STORE_A, actor, String(loc._id), { email: 'Buyer@A.com', role: 'location_admin' });
    expect(b.role).toBe('location_admin');
    expect(((await m.users.collection.findOne({ _id: new Types.ObjectId(uid) })) as any).tags).toContain('b2b');
    await expect(svc.addBuyer(STORE_A, actor, String(loc._id), { email: 'buyer@a.com' })).rejects.toThrow(/already belongs/);
    await expect(svc.addBuyer(STORE_B, actor, String(loc._id), { email: 'buyer@a.com' })).rejects.toThrow(/not found/i);
    await expect(svc.updateBuyer(STORE_A, actor, String(b._id), { role: 'admin' })).rejects.toThrow(/Unknown buyer role/);

    await svc.removeBuyer(STORE_A, actor, String(b._id));
    expect(((await m.users.collection.findOne({ _id: new Types.ObjectId(uid) })) as any).tags).not.toContain('b2b');
  });

  it('approving an application twice at once creates ONE company; rejecting a decided one fails', async () => {
    const uid = await mkUser(STORE_A, 'apply@a.com');
    const app = await m.applications.create({ storeId: STORE_A, userId: uid, email: 'apply@a.com', companyName: 'Applicant Ltd' });
    const res = await Promise.allSettled([svc.approveApplication(STORE_A, actor, String(app._id), {}), svc.approveApplication(STORE_A, actor, String(app._id), {})]);

    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await m.companies.countDocuments({ storeId: STORE_A, name: /Applicant Ltd/ })).toBe(1);
    const buyer: any = await m.buyers.findOne({ storeId: STORE_A, userId: uid });
    expect(buyer.role).toBe('location_admin');
    await expect(svc.rejectApplication(STORE_A, actor, String(app._id), {})).rejects.toThrow(/already decided/);
  });

  it('an application of another store cannot be approved from this store', async () => {
    const uid = await mkUser(STORE_B, 'b-apply@b.com');
    const app = await m.applications.create({ storeId: STORE_B, userId: uid, email: 'b-apply@b.com', companyName: 'B Applicant' });
    await expect(svc.approveApplication(STORE_A, actor, String(app._id), {})).rejects.toThrow(/already decided|not found/i);
    expect(((await m.applications.findById(app._id)) as any).status).toBe('pending');
  });

  it('catalog items: only variants of this store, validated breaks and rules, upsert is idempotent', async () => {
    const cat: any = await svc.createCatalog(STORE_A, actor, { name: 'Wholesale' });
    const mkVariant = async (storeId: string) => String((await m.variants.collection.insertOne({ storeId, productId: String(new Types.ObjectId()), isDelete: false })).insertedId);
    const mine = await mkVariant(STORE_A);
    const foreign = await mkVariant(STORE_B);

    await expect(svc.upsertCatalogItems(STORE_A, actor, String(cat._id), [{ variantId: foreign, fixedPrice: 1 }])).rejects.toThrow(/not in this store/);
    await expect(svc.upsertCatalogItems(STORE_A, actor, String(cat._id), [{ variantId: mine, priceBreaks: [{ minQty: 5, price: 8 }, { minQty: 10, price: 9 }] }])).rejects.toThrow(/cannot cost more/);
    await expect(svc.upsertCatalogItems(STORE_A, actor, String(cat._id), [{ variantId: mine, minQty: 5, increment: 6 }])).rejects.toThrow(/multiple/);
    await expect(svc.upsertCatalogItems(STORE_B, actor, String(cat._id), [{ variantId: foreign, fixedPrice: 1 }])).rejects.toThrow(/not found/i);

    const rows = [{ variantId: mine, fixedPrice: 50, minQty: 6, increment: 6, priceBreaks: [{ minQty: 12, price: 45 }] }];
    await svc.upsertCatalogItems(STORE_A, actor, String(cat._id), rows);
    await svc.upsertCatalogItems(STORE_A, actor, String(cat._id), rows);
    expect((await svc.listCatalogItems(STORE_A, String(cat._id), {})).total).toBe(1);
    expect((await svc.listCatalogs(STORE_A)).find((c: any) => String(c._id) === String(cat._id))?.itemCount).toBe(1);
    expect((await svc.listCatalogItems(STORE_B, String(cat._id), {})).total).toBe(0);
  });

  it('a catalog that is assigned cannot be deleted; unassigned can', async () => {
    const cat: any = await svc.createCatalog(STORE_A, actor, { name: 'In Use' });
    const c: any = await svc.createCompany(STORE_A, actor, { name: 'Uses Catalog', catalogId: String(cat._id) });
    await expect(svc.deleteCatalog(STORE_A, actor, String(cat._id))).rejects.toThrow(/assigned/);
    await svc.updateCompany(STORE_A, actor, String(c._id), { catalogId: null });
    await expect(svc.deleteCatalog(STORE_A, actor, String(cat._id))).resolves.toEqual({ success: true });
  });

  it('the last location of a company cannot be deleted, and a location with buyers cannot either', async () => {
    const c: any = await svc.createCompany(STORE_A, actor, { name: 'Loc Co' });
    const first: any = (await svc.getCompany(STORE_A, String(c._id))).locations[0];
    await expect(svc.deleteLocation(STORE_A, actor, String(first._id))).rejects.toThrow(/at least one/);
    const second: any = await svc.createLocation(STORE_A, actor, String(c._id), { name: 'Branch' });
    const uid = await mkUser(STORE_A, 'branch@a.com');
    expect(uid).toBeTruthy();
    await svc.addBuyer(STORE_A, actor, String(second._id), { email: 'branch@a.com' });
    await expect(svc.deleteLocation(STORE_A, actor, String(second._id))).rejects.toThrow(/buyers/);
  });
});
