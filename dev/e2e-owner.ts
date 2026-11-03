/* eslint-disable */
/**
 * DEV ONLY. Creates a brand-new throwaway owner (unique email) with a store, one register, POS tax settings and an
 * active POS plan, and prints its ids as JSON on the last stdout line. Used by the POS app's real-backend e2e (account
 * deletion must run on an owner nobody else uses). Never touches the seeded owners. Same dev-database guard as seed.ts.
 *   npx ts-node --transpile-only dev/e2e-owner.ts [--force]
 */
import * as fs from 'fs';
import * as path from 'path';
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const schema = require('../dist/database/schema');
const DAY = 86_400_000;

async function main() {
  const parsed = dotenv.parse(fs.readFileSync(path.join(__dirname, '.env.dev')));
  const uri = process.env.MONGO_URI || parsed.MONGO_URI;
  const dbName = new URL(uri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.replace(/^\//, '');
  if (!/dev/i.test(dbName) && !process.argv.includes('--force')) throw new Error(`Refusing: database "${dbName}" must contain "dev"`);
  const conn = await mongoose.createConnection(uri).asPromise();
  const M = (cls: any, sch: any) => conn.model(cls.name, sch);
  const Seller = M(schema.Seller, schema.SellerSchema), Store = M(schema.Store, schema.StoreSchema);
  const PosSettings = M(schema.PosSettings, schema.PosSettingsSchema), PosPlan = M(schema.PosPlan, schema.PosPlanSchema), PosPurchase = M(schema.PosPurchase, schema.PosPurchaseSchema);
  const plan: any = await PosPlan.findOne({ name: 'Dev POS Monthly' });
  if (!plan) throw new Error('Seed first (plan "Dev POS Monthly" missing)');
  const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `pos-e2e-${tag}@solvexo.dev`, password = 'DevPass#12345';
  const owner: any = await new Seller({ name: `POS E2E ${tag}`, email, role: 'seller', isVerified: true, password: await bcrypt.hash(password, 10), status: 'active' }).save();
  const sellerId = String(owner._id);
  const store: any = await new Store({ sellerId, name: `POS E2E Shop ${tag}`, slug: `pos-e2e-${tag}`, baseCurrency: 'USD', status: 'active', registers: [{ name: 'Register 1', defaultFloatCash: 100, status: 'active' }] }).save();
  const storeId = String(store._id);
  await PosSettings.updateOne({ storeId }, { $set: { taxRate: 0.1 }, $setOnInsert: { saleCounter: 0 } }, { upsert: true });
  const exp = new Date(Date.now() + 30 * DAY);
  await PosPurchase.create({ storeId, sellerId, planId: String(plan._id), planNameSnapshot: plan.name, priceSnapshot: plan.price, currencySnapshot: plan.currency, durationInDaysSnapshot: plan.durationInDays, purchasedAt: new Date(exp.getTime() - 30 * DAY), expiresAt: exp, source: 'manual', stripeCheckoutSessionId: `manual_dev_e2e_${storeId}`, grantReason: 'dev e2e throwaway' });
  console.log(JSON.stringify({ email, password, sellerId, storeId, registerId: String(store.registers[0]._id) }));
  await conn.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
