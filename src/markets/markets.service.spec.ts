// @ts-nocheck -- in-memory fake models; the assertions below are real.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { MarketsService, isProductAvailableInMarket } from './markets.service';

/** Tiny Mongo-like matcher: equality, $ne, $in (also against array fields). */
function matches(doc: any, filter: any): boolean {
  return Object.entries(filter ?? {}).every(([k, cond]: [string, any]) => {
    const val = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Types.ObjectId)) {
      if ('$ne' in cond) return String(val) !== String(cond.$ne);
      if ('$in' in cond) {
        const wanted = cond.$in.map(String);
        return Array.isArray(val) ? val.some((v) => wanted.includes(String(v))) : wanted.includes(String(val));
      }
    }
    return String(val) === String(cond);
  });
}

function query(result: any) {
  const q: any = Promise.resolve(result);
  q.lean = () => q; q.select = () => q; q.sort = () => q;
  return q;
}

function fakeModel(rows: any[]) {
  return {
    rows,
    find: (f) => query(rows.filter((r) => matches(r, f))),
    findOne: (f) => query(rows.find((r) => matches(r, f)) ?? null),
    exists: (f) => Promise.resolve(rows.some((r) => matches(r, f)) ? { _id: 1 } : null),
    countDocuments: (f) => Promise.resolve(rows.filter((r) => matches(r, f)).length),
    create: (doc) => { const row = { _id: new Types.ObjectId(), ...doc }; rows.push(row); return Promise.resolve(row); },
    updateMany: (f, u) => { rows.filter((r) => matches(r, f)).forEach((r) => Object.assign(r, u.$set ?? u)); return Promise.resolve({}); },
    updateOne: (f, u) => {
      const r = rows.find((x) => matches(x, f));
      if (r && u.$set) Object.assign(r, u.$set);
      if (r && u.$addToSet) for (const [k, v] of Object.entries(u.$addToSet)) { r[k] = Array.from(new Set([...(r[k] ?? []), v])); }
      return Promise.resolve({ matchedCount: r ? 1 : 0 });
    },
    findOneAndUpdate: (f, u) => { const r = rows.find((x) => matches(x, f)); if (r) Object.assign(r, u.$set); return Promise.resolve(r ?? null); },
  };
}

const STORE_ID = new Types.ObjectId().toString();
const OTHER_STORE = new Types.ObjectId().toString();
const PRODUCT_ID = new Types.ObjectId().toString();

function setup(opts: { enabledCurrencies?: string[] | null; maxMarkets?: number } = {}) {
  const stores = [{
    _id: STORE_ID, baseCurrency: 'PKR', enabledCurrencies: opts.enabledCurrencies ?? null, isDelete: false,
    customDomains: [{ domain: 'eu.shop.com', status: 'verified' }, { domain: 'new.shop.com', status: 'unverified' }],
  }];
  const markets = fakeModel([]);
  const storeModel = fakeModel(stores);
  storeModel.findById = (id) => query(stores.find((s) => String(s._id) === String(id)) ?? null);
  const products = fakeModel([{ _id: PRODUCT_ID, storeId: STORE_ID, isDelete: false }]);
  const marketPrices = fakeModel([]);
  const db = { repositories: { marketModel: markets, storeModel, productModel: products, marketPriceModel: marketPrices } };
  const adminConfig = { getEnabledCurrencies: jest.fn().mockResolvedValue(['PKR', 'USD', 'EUR', 'GBP'].map((code) => ({ code }))) };
  const entitlements = { getLimits: jest.fn().mockResolvedValue({ maxMarkets: opts.maxMarkets ?? -1 }) };
  const service = new MarketsService(db as any, adminConfig as any, entitlements as any);
  return { service, markets, stores, marketPrices };
}

describe('MarketsService', () => {
  it('makes the first market primary and active', async () => {
    const { service } = setup();
    const m: any = await service.create(STORE_ID, { name: 'Pakistan', countries: ['pk'], currency: 'pkr', isActive: false });
    expect(m.isPrimary).toBe(true);
    expect(m.isActive).toBe(true);
    expect(m.countries).toEqual(['PK']);
    expect(m.currency).toBe('PKR');
  });

  it('never lets the body move a market to another store or set internal fields', async () => {
    const { service, markets } = setup();
    const m: any = await service.create(STORE_ID, { name: 'PK', countries: ['PK'], currency: 'PKR' });
    await service.update(STORE_ID, String(m._id), { name: 'Pakistan', storeId: OTHER_STORE, isDelete: true, _id: 'x' } as any);
    const row = markets.rows.find((r) => String(r._id) === String(m._id));
    expect(row.storeId).toBe(STORE_ID);
    expect(row.isDelete).toBe(false);
    expect(row.name).toBe('Pakistan');
  });

  it('rejects a currency the platform has not enabled', async () => {
    const { service } = setup();
    await expect(service.create(STORE_ID, { name: 'X', countries: ['JP'], currency: 'JPY' })).rejects.toThrow(BadRequestException);
  });

  it('requires countries on a non-primary market and keeps each country in one market', async () => {
    const { service } = setup();
    await service.create(STORE_ID, { name: 'Home', countries: [], currency: 'PKR' });
    await expect(service.create(STORE_ID, { name: 'EU', countries: [], currency: 'EUR' })).rejects.toThrow(/at least one country/);
    await service.create(STORE_ID, { name: 'EU', countries: ['DE', 'FR'], currency: 'EUR' });
    await expect(service.create(STORE_ID, { name: 'France', countries: ['FR'], currency: 'EUR' })).rejects.toThrow(/already in the market "EU"/);
  });

  it('switching primary moves the flag; the primary market cannot be turned off, demoted or deleted while others exist', async () => {
    const { service, markets } = setup();
    const home: any = await service.create(STORE_ID, { name: 'Home', countries: ['PK'], currency: 'PKR' });
    const eu: any = await service.create(STORE_ID, { name: 'EU', countries: ['DE'], currency: 'EUR' });
    await expect(service.update(STORE_ID, String(home._id), { isActive: false })).rejects.toThrow(/cannot be turned off/);
    await expect(service.update(STORE_ID, String(home._id), { isPrimary: false })).rejects.toThrow(/another market primary/);
    await expect(service.remove(STORE_ID, String(home._id))).rejects.toThrow(/another market primary/);
    await service.update(STORE_ID, String(eu._id), { isPrimary: true });
    expect(markets.rows.filter((r) => r.isPrimary && !r.isDelete).map((r) => r.name)).toEqual(['EU']);
  });

  it('adds the market currency to the store checkout list, within the plan limit', async () => {
    const ok = setup({ enabledCurrencies: ['PKR'], maxMarkets: 2 });
    await ok.service.create(STORE_ID, { name: 'Home', countries: ['PK'], currency: 'PKR' });
    await ok.service.create(STORE_ID, { name: 'US', countries: ['US'], currency: 'USD' });
    expect(ok.stores[0].enabledCurrencies).toEqual(['PKR', 'USD']);
    await expect(ok.service.create(STORE_ID, { name: 'EU', countries: ['DE'], currency: 'EUR' })).rejects.toThrow(/plan allows up to 2/);
  });

  it('validates subfolders (format, reserved paths, unique) and domains (must be a verified store domain)', async () => {
    const { service } = setup();
    await service.create(STORE_ID, { name: 'Home', countries: [], currency: 'PKR' });
    await expect(service.create(STORE_ID, { name: 'CA', countries: ['CA'], currency: 'USD', domainType: 'subfolder', subfolder: 'Canada!' })).rejects.toThrow(/Subfolder/);
    const ca: any = await service.create(STORE_ID, { name: 'CA', countries: ['CA'], currency: 'USD', domainType: 'subfolder', subfolder: '/EN-CA/' });
    expect(ca.subfolder).toBe('en-ca');
    await expect(service.create(STORE_ID, { name: 'CA2', countries: ['MX'], currency: 'USD', domainType: 'subfolder', subfolder: 'en-ca' })).rejects.toThrow(/already uses/);
    await expect(service.create(STORE_ID, { name: 'EU', countries: ['DE'], currency: 'EUR', domainType: 'subdomain', domain: 'new.shop.com' })).rejects.toThrow(/verify/);
    const eu: any = await service.create(STORE_ID, { name: 'EU', countries: ['DE'], currency: 'EUR', domainType: 'subdomain', domain: 'https://EU.shop.com/' });
    expect(eu.domain).toBe('eu.shop.com');
  });

  it('manual exchange rate needs a rate', async () => {
    const { service } = setup();
    await expect(service.create(STORE_ID, { name: 'US', countries: [], currency: 'USD', pricingRule: { type: 'manual' } })).rejects.toThrow(/exchange rate/);
  });

  it('product availability only accepts this store\'s products', async () => {
    const { service } = setup();
    await expect(service.create(STORE_ID, {
      name: 'Home', countries: [], currency: 'PKR', productAvailability: 'include', productIds: [new Types.ObjectId().toString()],
    })).rejects.toThrow(/not in this store/);
    const m: any = await service.create(STORE_ID, { name: 'Home', countries: [], currency: 'PKR', productAvailability: 'exclude', productIds: [PRODUCT_ID] });
    expect(isProductAvailableInMarket(m, PRODUCT_ID)).toBe(false);
    expect(isProductAvailableInMarket({ ...m, productAvailability: 'include' }, PRODUCT_ID)).toBe(true);
    expect(isProductAvailableInMarket(null, PRODUCT_ID)).toBe(true);
  });

  describe('resolveForCheckout (Shopify: a country in no market can browse but not buy)', () => {
    it('no markets = nobody blocked', async () => {
      const { service } = setup();
      expect(await service.resolveForCheckout(STORE_ID, 'US')).toEqual({ market: null, blocked: false });
    });
    it('listed country buys in its market; others fall to a catch-all primary', async () => {
      const { service } = setup();
      await service.create(STORE_ID, { name: 'Home', countries: [], currency: 'PKR' });
      await service.create(STORE_ID, { name: 'EU', countries: ['DE'], currency: 'EUR' });
      expect((await service.resolveForCheckout(STORE_ID, 'de')).market.name).toBe('EU');
      expect((await service.resolveForCheckout(STORE_ID, 'US')).market.name).toBe('Home');
    });
    it('a primary market with its own countries does not cover the rest of the world', async () => {
      const { service } = setup();
      await service.create(STORE_ID, { name: 'Home', countries: ['PK'], currency: 'PKR' });
      expect((await service.resolveForCheckout(STORE_ID, 'PK')).blocked).toBe(false);
      expect(await service.resolveForCheckout(STORE_ID, 'US')).toEqual({ market: null, blocked: true });
      // Unknown country (no address, no IP country yet): primary market, not blocked.
      expect((await service.resolveForCheckout(STORE_ID, null)).market.name).toBe('Home');
    });
  });

  it('findOne rejects another store\'s market and junk ids', async () => {
    const { service } = setup();
    const m: any = await service.create(STORE_ID, { name: 'Home', countries: [], currency: 'PKR' });
    await expect(service.findOne(OTHER_STORE, String(m._id))).rejects.toThrow(NotFoundException);
    await expect(service.findOne(STORE_ID, 'nope')).rejects.toThrow(NotFoundException);
  });

  it('public payload exposes only storefront fields', async () => {
    const { service } = setup();
    await service.create(STORE_ID, { name: 'Home', countries: [], currency: 'PKR', languages: ['UR'] });
    const pub: any = await service.getPublicMarkets(STORE_ID);
    expect(pub.defaultLanguage).toBe('en');
    expect(pub.languages).toEqual(['en', 'ur']);
    expect(Object.keys(pub.markets[0])).not.toContain('storeId');
  });
});
