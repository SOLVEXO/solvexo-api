/* eslint-disable prettier/prettier */
/**
 * Development stores: creation (hidden, password, sample data, no trial used), limits, deletion, and the three rules
 * around them: no real checkout, every feature on, no plan to buy. Real MongoDB (skipped without MONGO_TEST_URI)
 * for the store itself; the guard and plan rules are checked directly.
 */
import mongoose, { Connection, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { BadRequestException } from '@nestjs/common';
import { DevelopmentStoresService, MAX_DEVELOPMENT_STORES, newStorePassword } from './development-stores.service';
import { BillingAccessGuard } from '../platform-plans/guards/billing-access.guard';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { assertNotDevelopment } from '../platform-plans/seller-platform-subscriptions.service';

describe('development store rules', () => {
  it('passwords are word-word-number and differ', () => {
    const a = newStorePassword(); const b = newStorePassword();
    expect(a).toMatch(/^[a-z]+-[a-z]+-\d{3}$/);
    expect(new Set(Array.from({ length: 20 }, newStorePassword)).size).toBeGreaterThan(1);
    expect(typeof b).toBe('string');
  });

  it('no plan can be bought, changed or cancelled for a development store; other stores are untouched', () => {
    expect(() => assertNotDevelopment({ status: 'development' })).toThrow(BadRequestException);
    for (const s of ['trialing', 'active', 'locked', undefined]) expect(() => assertNotDevelopment({ status: s })).not.toThrow();
    expect(() => assertNotDevelopment(null)).not.toThrow();
  });

  const guardFor = (status: string | null, opts: any) => {
    const reflector: any = { getAllAndOverride: () => opts };
    const db: any = { repositories: { sellerPlatformSubscriptionModel: { findOne: () => ({ select: () => ({ lean: async () => (status ? { status } : null) }) }) } } };
    const ctx: any = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ params: { storeId: 's1' }, body: {}, query: {} }) }) };
    return new BillingAccessGuard(reflector, db).canActivate(ctx);
  };

  it('checkout and payment routes refuse a development store; its dashboard routes still work', async () => {
    await expect(guardFor('development', { blockDuringTrial: true, audience: 'buyer' })).rejects.toThrow(/test store/);
    await expect(guardFor('development', { blockDuringTrial: true })).rejects.toThrow(/draft orders/);
    await expect(guardFor('development', {})).resolves.toBe(true);
    await expect(guardFor('active', { blockDuringTrial: true, audience: 'buyer' })).resolves.toBe(true);
  });

  it('a development store gets every feature (API included) but never a custom domain', async () => {
    const lean = (v: any) => jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(v) });
    const db: any = { repositories: {
      sellerPlatformSubscriptionModel: { findOne: lean({ storeId: 's1', status: 'development', platformPlanId: null }) },
      platformPlanModel: { findById: lean(null), findOne: lean(null) },
    } };
    const limits = await new EntitlementsService(db).getLimits('s1');
    expect(limits).toMatchObject({ apiWebhooksAllowed: true, maxProducts: -1, customDomainAllowed: false, b2bWholesaleAllowed: true });
  });
});

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('development stores on a real MongoDB', () => {
  jest.setTimeout(60000);
  let conn: Connection; let M: Record<string, any>; let svc: DevelopmentStoresService;
  const themes = { ensureDefaultTheme: jest.fn(async () => undefined) };
  const pages = { ensureHomePage: jest.fn(async () => undefined) };
  const invalidate = jest.fn();
  const DEV = new Types.ObjectId().toHexString();

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI as string, { dbName: `devstores_it_${Date.now()}` }).asPromise();
    const loose = (n: string) => conn.model(n, new mongoose.Schema({}, { strict: false, timestamps: true }));
    M = { storeModel: loose('Store'), sellerPlatformSubscriptionModel: loose('Sub'), productModel: loose('Product'), productVariantModel: loose('Variant'), categoryModel: loose('Category') };
    await M.categoryModel.create({ name: 'General', storeId: null, isDelete: false, status: 'active', sortOrder: 1 });
    svc = new DevelopmentStoresService(
      { repositories: M } as any, { log: jest.fn(async () => undefined) } as any,
      { getEnabledCurrencies: async () => [{ code: 'USD' }, { code: 'PKR' }] } as any,
      themes as any, pages as any, { invalidate } as any,
    );
  });
  afterAll(async () => { await conn?.dropDatabase(); await conn?.close(); });

  it('creates a hidden, password-protected, free test store with sample products, without touching the seller\'s trial', async () => {
    const r = await svc.create(DEV, { name: 'My Test Shop', currency: 'usd' });
    expect(r).toMatchObject({ name: 'My Test Shop', currency: 'USD', slug: 'my-test-shop-dev' });
    const s: any = await M.storeModel.findById(r.id).lean();
    expect(s).toMatchObject({ sellerId: DEV, isDevelopment: true, privacyMode: 'password', marketplaceHidden: true, status: 'active', baseCurrency: 'USD' });
    expect(await bcrypt.compare(r.password, s.storePasswordHash)).toBe(true);
    expect(JSON.stringify(s)).not.toContain(r.password);
    const subs: any[] = await M.sellerPlatformSubscriptionModel.find({ storeId: r.id }).lean();
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'development', amountUSD: 0, platformPlanId: null });
    expect(subs[0].trialEndsAt).toBeUndefined();
    expect(themes.ensureDefaultTheme).toHaveBeenCalledWith(r.id);
    expect(pages.ensureHomePage).toHaveBeenCalledWith(r.id);
    const products: any[] = await M.productModel.find({ storeId: r.id }).lean();
    expect(products.map((p) => p.name).sort()).toEqual(['Sample cotton kurta', 'Sample gift card design', 'Sample leather wallet']);
    const variants: any[] = await M.productVariantModel.find({ storeId: r.id }).lean();
    expect(variants).toHaveLength(4);
    expect(variants.find((v) => v.sku === 'SAMPLE-1-M')).toMatchObject({ stock: 20, currency: 'USD', isDefault: true, options: [{ name: 'Size', value: 'M' }] });
    expect(variants.find((v) => v.sku === 'SAMPLE-3')).toMatchObject({ unlimitedStock: true });
  });

  it('an unknown currency falls back to an enabled one; a name is required; at most three per account', async () => {
    await expect(svc.create(DEV, { name: '  ' })).rejects.toThrow(/name/);
    const r = await svc.create(DEV, { name: 'My Test Shop', currency: 'XYZ' });
    expect(r.currency).toBe('PKR');
    expect(r.slug).toMatch(/^my-test-shop-dev-[0-9a-f]{4}$/);
    await svc.create(DEV, { name: 'Third' });
    expect((await svc.list(DEV)).items).toHaveLength(MAX_DEVELOPMENT_STORES);
    await expect(svc.create(DEV, { name: 'Fourth' })).rejects.toThrow(/At most 3 development stores/);
  });

  it('only the owner can delete one; deleting frees a slot and ends its subscription', async () => {
    const [first] = (await svc.list(DEV)).items;
    await expect(svc.remove(new Types.ObjectId().toHexString(), first.id)).rejects.toThrow(/not found/);
    await expect(svc.remove(DEV, 'nope')).rejects.toThrow(/not found/);
    expect(await svc.remove(DEV, first.id)).toEqual({ success: true });
    expect(invalidate).toHaveBeenCalledWith(first.id);
    expect((await M.storeModel.findById(first.id).lean()).isDelete).toBe(true);
    expect((await M.sellerPlatformSubscriptionModel.findOne({ storeId: first.id }).lean()).isDelete).toBe(true);
    expect((await svc.list(DEV)).items).toHaveLength(2);
    await expect(svc.remove(DEV, first.id)).rejects.toThrow(/not found/);
    // A normal store of the same seller can't be deleted through this route.
    const live = await M.storeModel.create({ sellerId: DEV, name: 'Real shop', isDelete: false, isDevelopment: false });
    await expect(svc.remove(DEV, String(live._id))).rejects.toThrow(/not found/);
  });

  it('a failed setup leaves nothing half-made', async () => {
    const other = new Types.ObjectId().toHexString();
    themes.ensureDefaultTheme.mockRejectedValueOnce(new Error('theme down'));
    await expect(svc.create(other, { name: 'Broken' })).rejects.toThrow('theme down');
    expect(await M.storeModel.countDocuments({ sellerId: other })).toBe(0);
    expect(await M.sellerPlatformSubscriptionModel.countDocuments({ sellerId: other })).toBe(0);
  });
});

