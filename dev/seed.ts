/* eslint-disable */
/**
 * DEV ONLY seed for the local full-stack (dev/README.md). Idempotent. Refuses to run unless the database name contains
 * "dev" (or --force). Uses the compiled production Mongoose schemas (run `npm run build` first) so defaults/validation apply.
 *
 *   npx ts-node --transpile-only dev/seed.ts                  seed (or re-seed) everything
 *   npx ts-node --transpile-only dev/seed.ts --extras-only    only the portal-e2e owners (owner2..5@solvexo.dev, ids in dev/.logs/seed-e2e.json); leaves the main data untouched
 *   npx ts-node --transpile-only dev/seed.ts --expire-plan    make the main store's POS plan expired (plan-expiry / restricted-mode flow)
 *   npx ts-node --transpile-only dev/seed.ts --restore-plan   give it 30 days again
 *   npx ts-node --transpile-only dev/seed.ts --tamper-seal    G4.8: change one record of the latest sealed day (the integrity check must flag it)
 *   npx ts-node --transpile-only dev/seed.ts --untamper-seal  put it back exactly
 */
import * as fs from 'fs';
import * as path from 'path';
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const schema = require('../dist/database/schema');
import { seedG48, tamperSeal, untamperSeal } from './seed-g48';

const DAY = 86_400_000;
export const DEV = {
  ownerEmail: 'owner@solvexo.dev',
  ownerPassword: 'DevPass#12345',
  managerEmail: 'manager@solvexo.dev', managerPin: '1111',
  cashierEmail: 'cashier@solvexo.dev', cashierPin: '2222',
  storeSlug: 'dev-coffee', expiredStoreSlug: 'dev-expired-store',
};

/**
 * G3.2 / G3.3 dev data: a lot-tracked product with an EXPIRED lot, one expiring in 3 days and one in 25 days; two till customers (one with 20.00 store credit and loyalty
 * points, in the NEW ledger), and the loyalty rates (1 point per 10.00 spent, a point is worth 0.50). Idempotent.
 */
async function seedG3(conn: any, storeId: string, sellerId: string) {
  const db = conn.db!;
  const day = 86_400_000;
  const prod: any = await db.collection('products').findOne({ storeId, name: 'Dev Yogurt (lots)' });
  let pid = prod ? String(prod._id) : null;
  if (!pid) {
    const ins = await db.collection('products').insertOne({ sellerId, storeId, name: 'Dev Yogurt (lots)', slug: 'dev-yogurt', productType: 'physical', type: 'physical', isDelete: false, status: 'active', createdAt: new Date(), updatedAt: new Date() } as any);
    pid = String(ins.insertedId);
  }
  await db.collection('productvariants').updateOne({ productId: pid, sku: 'DEV-YOGURT' }, { $set: { productId: pid, storeId, sku: 'DEV-YOGURT', price: 4, barcode: '1000000000059', stock: 12, committedStock: 0, damagedStock: 0, inTransitStock: 0, unlimitedStock: false, trackLots: true, reorderPoint: 3, costPrice: 2, costPriceMinor: 200, isDefault: true, status: 'active', isDelete: false, options: [], expiredStock: 0, expiryBuckets: [] }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  const variant: any = await db.collection('productvariants').findOne({ productId: pid, sku: 'DEV-YOGURT' });
  const vid = String(variant._id);
  await db.collection('stocklots').deleteMany({ variantId: vid });
  const lot = (lotNumber: string, qty: number, days: number | null) => ({ storeId, productId: pid, variantId: vid, locationId: null, lotNumber, quantityReceived: qty, quantityRemaining: qty, costPrice: 2, costPriceMinor: 200, expiryDate: days === null ? null : new Date(Date.now() + days * day), supplierId: null, purchaseOrderId: null, receivedAt: new Date(Date.now() - 10 * day), status: 'active', createdAt: new Date(), updatedAt: new Date() });
  await db.collection('stocklots').insertMany([lot('LOT-OLD', 4, -3), lot('LOT-SOON', 5, 3), lot('LOT-LATER', 3, 25)] as any[]);
  await db.collection('productvariants').updateOne({ _id: variant._id }, { $set: { expiredStock: 4, expiryBuckets: [{ at: new Date(Date.now() + 3 * day), units: 5 }, { at: new Date(Date.now() + 25 * day), units: 3 }] } });

  // loyalty rates (the program itself must be enabled) + two till customers
  await db.collection('loyaltyprograms').updateOne({ storeId }, { $set: { storeId, isEnabled: true, posEarnSpendMinor: 1000, posRedeemMinorPerPoint: 50 }, $setOnInsert: { pointsPerDollar: 1, pointsPerReview: 0, pointsPerReferral: 0, birthdayBonusPoints: 0, pointsExpiryMonths: null, tiers: [{ name: 'Bronze', minPoints: 0, benefits: [] }, { name: 'Silver', minPoints: 100, benefits: [] }] } }, { upsert: true });
  const mkCust = async (name: string, phone: string) => {
    await db.collection('poscustomers').updateOne({ storeId, phone }, { $set: { storeId, name, phone, isDelete: false, source: 'dev-seed', marketingConsent: false }, $setOnInsert: { email: null, address: null, ntn: null, cnic: null, registrationType: null, group: null, notes: null, userId: null, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
    return String((await db.collection('poscustomers').findOne({ storeId, phone }))!._id);
  };
  const a = await mkCust('Dev Customer (credit)', '03001112222');
  await mkCust('Dev Customer (new)', '03004445555');
  if (!(await db.collection('storecreditentries').findOne({ storeId, customerId: a, legacyId: null }))) {
    const entryId = new mongoose.Types.ObjectId(); const lotId = new mongoose.Types.ObjectId();
    await db.collection('storecreditlots').insertOne({ _id: lotId, storeId, customerId: a, currency: 'USD', currencyExponent: 2, amountMinor: 2000, remainingMinor: 2000, expiresAt: null, expiredHandled: false, entryId: String(entryId), source: 'issue', legacyId: null, createdAt: new Date(), updatedAt: new Date() } as any);
    await db.collection('storecreditentries').insertOne({ _id: entryId, storeId, customerId: a, currency: 'USD', currencyExponent: 2, type: 'issue', amountMinor: 2000, balanceAfterMinor: 2000, lotId: String(lotId), expiresAt: null, consumed: [], note: 'dev seed', idemKey: 'dev-seed-credit', actorId: 'seed', actorRole: 'seller', legacyId: null, createdAt: new Date() } as any);
  }
  await db.collection('loyaltymembers').updateOne({ storeId, userId: a }, { $set: { storeId, userId: a, pointsBalance: 40, lifetimePoints: 40, currentTier: 'Bronze', lastActivityAt: new Date() } }, { upsert: true });
}

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

  if (process.argv.includes('--tamper-seal') || process.argv.includes('--untamper-seal')) {
    if (!mainStore) throw new Error('Seed first');
    const r = process.argv.includes('--tamper-seal') ? await tamperSeal(conn, String(mainStore._id)) : await untamperSeal(conn);
    console.log(JSON.stringify(r));
    await conn.close();
    return;
  }

  // --- portal e2e extras (--extras-only runs ONLY this block, so it never disturbs the main owner/store other runs use) ------
  // owner2: store + active plan (Devices page) · owner3: in-session deletion · owner4: public OTP deletion · owner5: no plan (buy/extend)
  const seedExtras = async () => {
    const plan: any = await PosPlan.findOne({ name: 'Dev POS Monthly' });
    if (!plan) throw new Error('Seed the main data first (plan "Dev POS Monthly" missing)');
    const pw = await bcrypt.hash(DEV.ownerPassword, 10);
    const res: any = {};
    for (const x of [
      { key: 'owner2', email: 'owner2@solvexo.dev', store: 'E2E Devices Shop', slug: 'e2e-devices-shop', planDays: 30 },
      { key: 'owner3', email: 'owner3@solvexo.dev', store: 'E2E Delete Shop', slug: 'e2e-delete-shop', planDays: 30 },
      { key: 'owner4', email: 'owner4@solvexo.dev', store: 'E2E Public Delete Shop', slug: 'e2e-public-delete-shop', planDays: 30 },
      { key: 'owner5', email: 'owner5@solvexo.dev', store: 'E2E No Plan Shop', slug: 'e2e-no-plan-shop', planDays: 0 },
    ]) {
      let o: any = await Seller.findOne({ email: x.email });
      if (!o) o = new Seller({ name: `E2E ${x.key}`, email: x.email, role: 'seller', isVerified: true });
      o.password = pw; o.status = 'active'; o.isDelete = false; o.deletionRequestedAt = null; o.deletionScheduledFor = null; o.otp = null; o.otpExpiresAt = null; o.otpAttempts = 0;
      await o.save();
      const sid = String(o._id);
      let s: any = await Store.findOne({ slug: x.slug });
      if (!s) s = new Store({ sellerId: sid, name: x.store, slug: x.slug, baseCurrency: 'USD' });
      s.sellerId = sid; s.name = x.store; s.status = 'active'; s.isDelete = false; s.baseCurrency = 'USD';
      if (!s.registers?.length) s.registers = [{ name: 'Register 1', defaultFloatCash: 100, status: 'active' }];
      await s.save();
      await PosSettings.updateOne({ storeId: String(s._id) }, { $set: { taxRate: 0.1 }, $setOnInsert: { saleCounter: 0 } }, { upsert: true });
      if (x.planDays > 0) {
        const exp = new Date(Date.now() + x.planDays * DAY);
        await PosPurchase.updateOne({ stripeCheckoutSessionId: `manual_dev_seed_${s._id}` }, { $set: { storeId: String(s._id), sellerId: sid, planId: String(plan._id), planNameSnapshot: plan.name, priceSnapshot: plan.price, currencySnapshot: plan.currency, durationInDaysSnapshot: plan.durationInDays, purchasedAt: new Date(exp.getTime() - 30 * DAY), expiresAt: exp, source: 'manual', grantReason: 'dev seed (e2e)', revokedAt: null, reversedAt: null } }, { upsert: true });
      } else {
        await PosPurchase.deleteMany({ storeId: String(s._id) });
      }
      // Keep a clean slate for the portal e2e: no refresh families / revoked devices left from earlier runs.
      await conn.collection('refreshtokenfamilies').deleteMany({ userId: sid });
      await conn.collection('posdevices').deleteMany({ storeId: String(s._id) });
      res[x.key] = { email: x.email, password: DEV.ownerPassword, sellerId: sid, storeId: String(s._id), registerId: String(s.registers[0]._id) };
    }
    const f = path.join(__dirname, '.logs', 'seed-e2e.json');
    fs.writeFileSync(f, JSON.stringify(res, null, 2));
    console.log(JSON.stringify(res, null, 2));
  };
  if (process.argv.includes('--extras-only')) { await seedExtras(); await conn.close(); return; }

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
  // G2.3: the main store is business-verified with a (mock) provider sub-merchant, so Raast QR works in the dev stack; the "Expired Store"
  // has NO verification (digital payments refused there). Documents / identifiers are not seeded — only the status the gate reads.
  await conn.collection('store_kybs').updateOne(
    { storeId },
    { $set: { storeId, sellerId, status: 'verified', businessType: 'sole_proprietor', legalBusinessName: 'Dev Coffee', subMerchant: { ref: 'SM-DEV-1', providerKey: 'mock', setAt: new Date(), setBy: 'dev-seed' }, purgedAt: null }, $setOnInsert: { documents: [], history: [] } },
    { upsert: true },
  );
  await conn.collection('store_kybs').deleteMany({ storeId: String(expiredStore._id) });

  // --- catalog ---------------------------------------------------------------------------------------------
  let category: any = await Category.findOne({ name: 'Dev Drinks', storeId });
  if (!category) category = await Category.create({ name: 'Dev Drinks', storeId, sellerId });
  const categoryId = String(category._id);
  // G2.7: a small platform category TREE (storeId null, like the real marketplace tree) so the POS catalog "Category" dropdown can be tested.
  const ensureCategory = async (name: string, parent: any | null, sortOrder: number) => {
    let c: any = await Category.findOne({ name, storeId: null, parentId: parent ? String(parent._id) : null });
    if (!c) c = await Category.create({ name, slug: `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, parentId: parent ? String(parent._id) : null, storeId: null, sortOrder, status: 'active', isDelete: false, createdByRole: 'admin' });
    return c;
  };
  const catBeverages = await ensureCategory('Beverages', null, 1);
  await ensureCategory('Hot drinks', catBeverages, 1);
  await ensureCategory('Cold drinks', catBeverages, 2);
  const catBakery = await ensureCategory('Bakery', null, 2);
  await ensureCategory('Pastries', catBakery, 1);
  const catPantry = await ensureCategory('Pantry', null, 3);
  await ensureCategory('Coffee beans', catPantry, 1);
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
  await seedExtras();
  await seedG3(conn, storeId, sellerId);
  const g48 = await seedG48(conn, storeId, sellerId);
  console.log(JSON.stringify({ g48 }));
  await conn.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
