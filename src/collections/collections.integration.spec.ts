/* eslint-disable prettier/prettier */
/**
 * Real-MongoDB tests for "put a product in many collections" (product form -> Collections). Skipped unless
 * COLLECTIONS_IT_MONGO is set (a plain standalone mongod is enough), e.g.
 *   COLLECTIONS_IT_MONGO="mongodb://127.0.0.1:27097" npx jest collections.integration
 * Creates a throw-away database and drops it afterwards. NEVER point this at a shared/production cluster.
 */
import mongoose, { Connection } from 'mongoose';
import { CollectionSchema } from './schemas/collection.schema';
import { CollectionsService } from './collections.service';

const URI = process.env.COLLECTIONS_IT_MONGO;
const d = URI ? describe : describe.skip;

d('Product <-> collections on a real MongoDB', () => {
  let conn: Connection;
  let svc: CollectionsService;
  let collectionModel: any;
  let sA: string, sB: string, p1: string, p2: string, pOther: string, H: string, R: string, A: string, F: string;
  const SELLER_A = 'sellerA';
  const SELLER_B = 'sellerB';

  beforeAll(async () => {
    conn = await mongoose.createConnection(`${URI!.replace(/\/$/, '')}/collections_it_${Date.now()}`).asPromise();
    const loose = new mongoose.Schema({}, { strict: false });
    collectionModel = conn.model('Collection', CollectionSchema);
    const storeModel = conn.model('Store', loose);
    const productModel = conn.model('Product', loose);
    const seoRedirectModel = conn.model('SeoRedirect', loose);
    svc = new CollectionsService({ repositories: { collectionModel, storeModel, productModel, seoRedirectModel } } as any, { log: () => undefined } as any);
    sA = String((await storeModel.create({ sellerId: SELLER_A, isDelete: false }))._id);
    sB = String((await storeModel.create({ sellerId: SELLER_B, isDelete: false }))._id);
    p1 = String((await productModel.create({ storeId: sA, isDelete: false }))._id);
    p2 = String((await productModel.create({ storeId: sA, isDelete: false }))._id);
    pOther = String((await productModel.create({ storeId: sB, isDelete: false }))._id);
    H = String(((await svc.create(sA, SELLER_A, { name: 'Horror', type: 'manual' } as any)).data as any)._id);
    R = String(((await svc.create(sA, SELLER_A, { name: 'Romance', type: 'manual' } as any)).data as any)._id);
    A = String(((await svc.create(sA, SELLER_A, { name: 'Auto', type: 'automatic', rules: { tags: ['x'] } } as any)).data as any)._id);
    F = String(((await svc.create(sB, SELLER_B, { name: 'Foreign', type: 'manual' } as any)).data as any)._id);
  });

  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  const idsOf = async (productId: string) => (await svc.collectionIdsForProduct(sA, SELLER_A, productId)).data.collectionIds.sort();

  it('allows an empty manual collection', async () => {
    expect((await collectionModel.findById(H)).productIds).toEqual([]);
  });

  it('puts one product in two collections, and removes it from one without touching another product', async () => {
    await svc.setCollectionsForProduct(sA, SELLER_A, p1, [H, R]);
    expect(await idsOf(p1)).toEqual([H, R].sort());
    await svc.setCollectionsForProduct(sA, SELLER_A, p2, [R]);
    await svc.setCollectionsForProduct(sA, SELLER_A, p1, [R]);
    expect((await collectionModel.findById(H)).productIds).not.toContain(p1);
    const romance = (await collectionModel.findById(R)).productIds;
    expect(romance.filter((x: string) => x === p1)).toHaveLength(1);
    expect(romance).toContain(p2);
  });

  it('is idempotent and an empty list removes the product from every collection', async () => {
    await svc.setCollectionsForProduct(sA, SELLER_A, p1, [R]);
    expect((await collectionModel.findById(R)).productIds.filter((x: string) => x === p1)).toHaveLength(1);
    await svc.setCollectionsForProduct(sA, SELLER_A, p1, []);
    expect(await idsOf(p1)).toEqual([]);
  });

  it('rejects automatic collections, other stores, other sellers, bad ids and deleted collections', async () => {
    await expect(svc.setCollectionsForProduct(sA, SELLER_A, p1, [A])).rejects.toBeDefined();
    await expect(svc.setCollectionsForProduct(sA, SELLER_A, p1, [F])).rejects.toBeDefined();
    await expect(svc.setCollectionsForProduct(sA, SELLER_A, pOther, [H])).rejects.toBeDefined();
    await expect(svc.setCollectionsForProduct(sA, SELLER_B, p1, [H])).rejects.toBeDefined();
    await expect(svc.setCollectionsForProduct(sA, SELLER_A, p1, ['nope'])).rejects.toBeDefined();
    await expect(svc.collectionIdsForProduct(sA, SELLER_B, p1)).rejects.toBeDefined();
    expect((await collectionModel.findById(F)).productIds).toEqual([]);
    await collectionModel.updateOne({ _id: H }, { $set: { isDelete: true } });
    await expect(svc.setCollectionsForProduct(sA, SELLER_A, p1, [H])).rejects.toBeDefined();
  });
});
