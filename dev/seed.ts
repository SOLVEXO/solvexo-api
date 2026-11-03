/* eslint-disable */
/**
 * DEV ONLY seed for the local full-stack (dev/README.md). Idempotent. Refuses to run unless the database name contains
 * "dev" (or --force). Uses the compiled production Mongoose schemas (run `npm run build` first) so defaults/validation apply.
 *
 *   npx ts-node --transpile-only dev/seed.ts                  seed (or re-seed) everything
 *   npx ts-node --transpile-only dev/seed.ts --expire-plan    make the main store's POS plan expired (plan-expiry / restricted-mode flow)
 *   npx ts-node --transpile-only dev/seed.ts --restore-plan   give it 30 days again
 */
import * as fs from 'fs';
import * as path from 'path';
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const schema = require('../dist/database/schema');

const DAY = 86_400_000;
export const DEV = {
  ownerEmail: 'owner@solvexo.dev',
  ownerPassword: 'DevPass#12345',
  managerEmail: 'manager@solvexo.dev', managerPin: '1111',
  cashierEmail: 'cashier@solvexo.dev', cashierPin: '2222',
  storeSlug: 'dev-coffee', expiredStoreSlug: 'dev-expired-store',
};

async function main() {
  const envFile = path.join(__dirname, '.env.dev');
  const parsed = dotenv.parse(fs.readFileSync(envFile));
  const uri = process.env.MONGO_URI || parsed.MONGO_URI;
  const force = process.argv.includes('--force');
  const dbName = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
  if (!/dev/i.test(dbName) && !force) throw new Error(`Refusing to seed database "${dbName}" (name must contain "dev", or pass --force)`);
  const conn = await mongoose.createConnection(uri).asPromise();
  const M = (cls: any, sch: any) => conn.model(cls.name, sch);
  const Seller = M(schema.Seller, schema.SellerSchema);
  const Store = M(schema.Store, schema.StoreSchema);
  const Category = M(schema.Category, schema.CategorySchema);
  const Product = M(schema.Product, schema.ProductSchema);
  const Variant = M(schema.ProductVariant, schema.ProductVariantSchema);
  const Employee = M(schema.Employee, schema.EmployeeSchema);
  const PosSettings = M(schema.PosSettings, schema.PosSettingsSchema);
  const PosPlan = M(schema.PosPlan, schema.PosPlanSchema);
  const PosPurchase = M(schema.PosPurchase, schema.PosPurchaseSchema);

  const mainStore: any = await Store.findOne({ slug: DEV.storeSlug });
  if (process.argv.includes('--expire-plan') || process.argv.includes('--restore-plan')) {
    if (!mainStore) throw new Error('Seed first');
    const expire = process.argv.includes('--expire-plan');
    const when = expire ? new Date(Date.now() - 2 * DAY) : new Date(Date.now() + 30 * DAY);
    const r = await PosPurchase.updateMany({ storeId: String(mainStore._id), source: 'manual', stripeCheckoutSessionId: /^manual_dev_seed/ }, { $set: { expiresAt: when, revokedAt: null, reversedAt: null } });
    console.log(`${expire ? 'Expired' : 'Restored'} the main store's POS plan (${r.modifiedCount} purchase updated; expiresAt=${when.toISOString()})`);
    await conn.close();
    return;
  }

  // --- owner ---------------------------------------------------------------------------------------------
  let owner: any = await Seller.findOne({ email: DEV.ownerEmail });
  const passwordHash = await bcrypt.hash(DEV.ownerPassword, 10);
  if (!owner) owner = new Seller({ name: 'Dev Owner', email: DEV.ownerEmail, role: 'seller', isVerified: true });
  owner.password = passwordHash; owner.status = 'active'; owner.isDelete = false;
  owner.deletionRequestedAt = null; owner.deletionScheduledFor = null;
  await owner.save();
  const sellerId = String(owner._id);

  // --- stores ----------------------------------------------------------------------------------------------
  const upsertStore = async (slug: string, name: string) => {
    let s: any = await Store.findOne({ slug });
    if (!s) s = new Store({ sellerId, name, slug, baseCurrency: 'USD' });
    s.sellerId = sellerId; s.name = name; s.status = 'active'; s.isDelete = false; s.baseCurrency = 'USD';
    if (!s.registers?.length) s.registers = [{ name: 'Register 1', defaultFloatCash: 100, status: 'active' }];
    await s.save();
    return s;
  };
  const store = await upsertStore(DEV.storeSlug, 'Dev Coffee');
  const expiredStore = await upsertStore(DEV.expiredStoreSlug, 'Expired Store');
  const storeId = String(store._id);

  // --- POS settings: 10% tax (exclusive, applied to subtotal), USD ----------------------------------------
  await PosSettings.updateOne({ storeId }, { $set: { taxRate: 0.1, businessName: 'Dev Coffee', businessAddress: '1 Dev Street', businessTaxId: 'DEV-TAX-1', currencySymbol: '$' }, $setOnInsert: { saleCounter: 0 } }, { upsert: true });
  await PosSettings.updateOne({ storeId: String(expiredStore._id) }, { $set: { taxRate: 0.1 }, $setOnInsert: { saleCounter: 0 } }, { upsert: true });

  // --- catalog ---------------------------------------------------------------------------------------------
  let category: any = await Category.findOne({ name: 'Dev Drinks', storeId });
  if (!category) category = await Category.create({ name: 'Dev Drinks', storeId, sellerId });
  const categoryId = String(category._id);
  const upsertProduct = async (name: string, sku: string, price: number, v: { stock: number; unlimited?: boolean; reorderPoint?: number; barcode?: string }) => {
    let p: any = await Product.findOne({ storeId, name });
    if (!p) p = new Product({ sellerId, storeId, name, slug: sku.toLowerCase(), productType: 'physical', type: 'physical', categoryId });
    p.isDelete = false; p.status = 'active';
    await p.save();
    const pid = String(p._id);
    await Variant.updateOne({ productId: pid, sku }, { $set: { productId: pid, storeId, sku, price, barcode: v.barcode ?? null, stock: v.stock, committedStock: 0, unlimitedStock: v.unlimited === true, reorderPoint: v.reorderPoint ?? null, isDefault: true, status: 'active', isDelete: false, options: [] } }, { upsert: true });
    return pid;
  };
  await upsertProduct('Dev Latte (limited stock)', 'DEV-LATTE', 5, { stock: 20, reorderPoint: 5, barcode: '1000000000011' });
  await upsertProduct('Dev Refill (unlimited)', 'DEV-REFILL', 2.5, { stock: 0, unlimited: true, barcode: '1000000000028' });
  await upsertProduct('Dev Croissant (low stock)', 'DEV-CROISSANT', 3.75, { stock: 2, reorderPoint: 5, barcode: '1000000000035' });
  await upsertProduct('Dev Beans 1kg', 'DEV-BEANS', 24, { stock: 8, barcode: '1000000000042' });

  // --- employees (PINs are bcrypt hashed, like PosService.createEmployee) ----------------------------------
  const upsertEmployee = async (name: string, email: string, role: string, pin: string) => {
    let e: any = await Employee.findOne({ storeId, email });
    if (!e) e = new Employee({ storeId, sellerId, name, email, role });
    e.pin = await bcrypt.hash(pin, 10); e.role = role; e.status = 'active'; e.isDelete = false; e.pinFailedAttempts = 0; e.pinLockedUntil = null;
    await e.save();
  };
  await upsertEmployee('Dev Manager', DEV.managerEmail, 'manager', DEV.managerPin);
  await upsertEmployee('Dev Cashier', DEV.cashierEmail, 'cashier', DEV.cashierPin);

  // --- POS plan + purchases (manual grant shape; the main store active ~30 days, the second store expired) ---
  let plan: any = await PosPlan.findOne({ name: 'Dev POS Monthly' });
  if (!plan) plan = await PosPlan.create({ name: 'Dev POS Monthly', price: 19, currency: 'USD', durationInDays: 30, description: 'Seeded dev plan', isActive: true });
  const grant = async (st: any, expiresAt: Date) => {
    const key = `manual_dev_seed_${st._id}`;
    await PosPurchase.updateOne({ stripeCheckoutSessionId: key }, { $set: { storeId: String(st._id), sellerId, planId: String(plan._id), planNameSnapshot: plan.name, priceSnapshot: plan.price, currencySnapshot: plan.currency, durationInDaysSnapshot: plan.durationInDays, purchasedAt: new Date(expiresAt.getTime() - 30 * DAY), expiresAt, source: 'manual', grantReason: 'dev seed', revokedAt: null, reversedAt: null } }, { upsert: true });
  };
  await grant(store, new Date(Date.now() + 30 * DAY));
  await grant(expiredStore, new Date(Date.now() - 5 * DAY));

  const out = { owner: { email: DEV.ownerEmail, password: DEV.ownerPassword, sellerId }, store: { id: storeId, slug: DEV.storeSlug, registerId: String(store.registers[0]._id) }, expiredStore: { id: String(expiredStore._id) }, manager: { email: DEV.managerEmail, pin: DEV.managerPin }, cashier: { email: DEV.cashierEmail, pin: DEV.cashierPin }, planId: String(plan._id) };
  fs.writeFileSync(path.join(__dirname, '.logs', 'seed.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await conn.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
