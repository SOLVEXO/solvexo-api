/* eslint-disable prettier/prettier */
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose, { Connection, Types } from 'mongoose';
import * as schema from '@/database/schema';

/**
 * A REAL MongoDB (mongodb-memory-server — a genuine mongod process, not a mock) with the production
 * Mongoose schemas, so integration tests exercise the real unique/sparse/partial indexes, atomic
 * `findOneAndUpdate` claims and `$gte`-guarded `$inc` that the sale pipeline depends on. Runs in the normal
 * `npm test`; the first run downloads the mongod binary (cached afterwards).
 *
 * Fixtures are written with raw collection inserts so they don't have to satisfy every required field of the
 * big Store/Product schemas — the code under test reads them exactly as it would in production.
 */
export interface MongoHarness {
  conn: Connection;
  /** The same shape as `DatabaseService.repositories` for the models the POS code touches. */
  repos: Record<string, any>;
  stop: () => Promise<void>;
  /** Drops all data (keeps indexes) between tests. */
  reset: () => Promise<void>;
}

export async function startMongoHarness(): Promise<MongoHarness> {
  // Normal path: the ONE shared mongod started by test/jest-global-setup.ts, with a database of our own so
  // suites can't see each other's data. Fallback (e.g. running a spec outside jest's globalSetup): our own mongod.
  const sharedUri = process.env.TEST_MONGO_URI;
  const own = sharedUri ? null : await MongoMemoryServer.create();
  const dbName = `pos_test_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const conn = await mongoose.createConnection(sharedUri ?? own!.getUri(), { dbName }).asPromise();

  const m = (cls: any, sch: any) => conn.model(cls.name, sch);
  const repos: Record<string, any> = {
    storeModel: m(schema.Store, schema.StoreSchema),
    saleModel: m(schema.Sale, schema.SaleSchema),
    registerSessionModel: m(schema.RegisterSession, schema.RegisterSessionSchema),
    employeeModel: m(schema.Employee, schema.EmployeeSchema),
    productVariantModel: m(schema.ProductVariant, schema.ProductVariantSchema),
    productModel: m(schema.Product, schema.ProductSchema),
    posSettingsModel: m(schema.PosSettings, schema.PosSettingsSchema),
    variantLocationStockModel: m(schema.VariantLocationStock, schema.VariantLocationStockSchema),
    storeLocationModel: m(schema.StoreLocation, schema.StoreLocationSchema),
    posAuditLogModel: m(schema.PosAuditLog, schema.PosAuditLogSchema),
    orderModel: m(schema.Order, schema.OrderSchema),
    userModel: m(schema.User, schema.UserSchema),
    storeCustomerMetaModel: m(schema.StoreCustomerMeta, schema.StoreCustomerMetaSchema),
    posPurchaseModel: m(schema.PosPurchase, schema.PosPurchaseSchema),
    posPlanModel: m(schema.PosPlan, schema.PosPlanSchema),
    posSettingsVersionModel: m(schema.PosSettingsVersion, schema.PosSettingsVersionSchema),
    idempotencyRecordModel: m(schema.IdempotencyRecord, schema.IdempotencyRecordSchema),
  };
  // Build every index now (unique sale key, unique open session per register, …) so tests hit the real constraints.
  await Promise.all(Object.values(repos).map((model) => model.init()));

  return {
    conn,
    repos,
    stop: async () => {
      if (sharedUri) await conn.dropDatabase();
      await conn.close();
      if (own) await own.stop();
    },
    reset: async () => {
      for (const model of Object.values(repos)) await model.deleteMany({});
    },
  };
}

export const oid = () => new Types.ObjectId();
export const oidStr = () => String(new Types.ObjectId());

/** A store with one register, one product/variant and a manager + cashier — everything a sale needs. */
export async function seedStore(
  h: MongoHarness,
  opts: { stock?: number; unlimited?: boolean; price?: number; baseCurrency?: string; taxRate?: number } = {},
) {
  const r = h.repos;
  const sellerId = oidStr();
  const storeId = oid();
  const registerId = oid();
  await r.storeModel.collection.insertOne({
    _id: storeId, sellerId, name: 'Test Store', slug: `store-${storeId}`, isDelete: false, status: 'active',
    baseCurrency: opts.baseCurrency ?? 'USD',
    registers: [{ _id: registerId, name: 'Register 1', status: 'active' }],
  });
  if (opts.taxRate !== undefined) {
    await r.posSettingsModel.collection.insertOne({ storeId: String(storeId), taxRate: opts.taxRate, saleCounter: 0 });
  }
  const productId = oidStr();
  await r.productModel.collection.insertOne({ _id: new Types.ObjectId(productId), storeId: String(storeId), sellerId, name: 'Tea', type: 'physical', isDelete: false, status: 'active', gallery: [] });
  const variantId = oidStr();
  await r.productVariantModel.collection.insertOne({
    _id: new Types.ObjectId(variantId), productId, sku: 'TEA-1', price: opts.price ?? 10,
    stock: opts.stock ?? 5, committedStock: 0, unlimitedStock: opts.unlimited === true,
    isDelete: false, status: 'active', options: [], isDefault: true,
  });
  const managerId = oidStr();
  const cashierId = oidStr();
  await r.employeeModel.collection.insertMany([
    { _id: new Types.ObjectId(managerId), storeId: String(storeId), name: 'Mia Manager', email: 'm@x.com', role: 'manager', isDelete: false },
    { _id: new Types.ObjectId(cashierId), storeId: String(storeId), name: 'Cal Cashier', email: 'c@x.com', role: 'cashier', isDelete: false },
  ]);
  return { sellerId, storeId: String(storeId), registerId: String(registerId), productId, variantId, managerId, cashierId };
}

export async function stockOf(h: MongoHarness, variantId: string): Promise<number> {
  const v: any = await h.repos.productVariantModel.collection.findOne({ _id: new Types.ObjectId(variantId) });
  return v.stock;
}
