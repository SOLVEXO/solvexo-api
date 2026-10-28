import { StoreService } from './store.service';

/**
 * Public product list: price filter, price sort and the price facet follow the price the BUYER sees
 * (market manual rate, fixed prices), not the catalogue price in the store currency.
 */

const chain = (result: any) => {
  const c: any = {
    select: () => c,
    limit: () => c,
    sort: () => c,
    skip: () => c,
    lean: () => Promise.resolve(result),
    then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
  };
  return c;
};

// PKR store. Black Cap 900 (US fixed price $9.99), Tee 1500, Jacket 5000, Socks 200.
const PRODUCTS = [
  { _id: 'cap', name: 'Black Cap' },
  { _id: 'tee', name: 'Tee' },
  { _id: 'jkt', name: 'Jacket' },
  { _id: 'soc', name: 'Socks' },
];
const VARIANTS = [
  { _id: 'v-cap', productId: 'cap', price: 900, unlimitedStock: true },
  { _id: 'v-tee-s', productId: 'tee', price: 1500, unlimitedStock: true },
  { _id: 'v-tee-m', productId: 'tee', price: 2000, unlimitedStock: true },
  { _id: 'v-jkt', productId: 'jkt', price: 5000, unlimitedStock: true },
  { _id: 'v-soc', productId: 'soc', price: 200, unlimitedStock: true },
];

function make(market: any | null, fixed: Record<string, number> = {}, rates: Record<string, number> = { PKR: 280, USD: 1, EUR: 0.92 }) {
  const aggregate = jest.fn(async (pipeline: any[]) => {
    const sorted = pipeline.some((s) => s.$sort);
    const byProduct = new Map<string, any>();
    const list = sorted ? [...VARIANTS].sort((a, b) => a.price - b.price) : VARIANTS;
    for (const v of list) {
      const g = byProduct.get(v.productId);
      if (!g) byProduct.set(v.productId, { _id: v.productId, cheapestVariantId: v._id, minPrice: v.price, inStock: 1, options: [[]] });
      else g.minPrice = Math.min(g.minPrice, v.price);
    }
    return [...byProduct.values()];
  });
  const productModel: any = {
    find: jest.fn((filter: any) => {
      if (filter?._id?.$in) return chain(PRODUCTS.filter((p) => filter._id.$in.includes(p._id)));
      return chain(PRODUCTS);
    }),
    countDocuments: jest.fn(async () => PRODUCTS.length),
  };
  const db: any = {
    repositories: {
      storeModel: { findOne: () => chain({ _id: 's1', baseCurrency: 'PKR', sellerId: 'sel' }) },
      productModel,
      productVariantModel: { aggregate, find: () => chain(VARIANTS) },
      sellerModel: { findById: () => chain({ name: 'Seller', isVerified: true }) },
      marketModel: { findOne: () => chain(market) },
    },
  };
  const svc: any = Object.create(StoreService.prototype);
  svc.databaseService = db;
  svc.marketingService = { getActiveCampaignsForStore: async () => [] };
  svc.exchangeRateService = {
    getCurrentRate: async (c: string) => (rates[c] ? { ratePerUSD: rates[c] } : null),
  };
  svc.marketPricingService = {
    fixedPricesFor: async () =>
      new Map(Object.entries(fixed).map(([productId, fixedPrice]) => [`${productId}:`, { productId, variantId: null, fixedPrice, compareAtPrice: null }])),
  };
  return svc;
}

const US_MARKET = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', currency: 'USD', pricingRule: { type: 'manual', manualRate: 0.0035 } };
const US_QUERY = { currency: 'USD', marketId: 'aaaaaaaaaaaaaaaaaaaaaaaa', facets: 'true' };
const names = (res: any) => res.data.products.map((p: any) => p.name);

describe('getPublicStoreProducts: prices the buyer sees', () => {
  it('filters by the displayed market price, including the fixed-price edge $9.99', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const res = await svc.getPublicStoreProducts('s1', { ...US_QUERY, minPrice: '9.99', maxPrice: '9.99' });
    expect(names(res)).toEqual(['Black Cap']);
  });

  it('a $5-$10 range finds the Black Cap shown at $9.99 and the Tee shown at $5.25', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const res = await svc.getPublicStoreProducts('s1', { ...US_QUERY, minPrice: '5', maxPrice: '10' });
    expect(names(res).sort()).toEqual(['Black Cap', 'Tee']);
  });

  it('the Tee is judged on its cheapest variant (1500 x 0.0035 = $5.25), inclusive edge', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const res = await svc.getPublicStoreProducts('s1', { ...US_QUERY, minPrice: '5.25', maxPrice: '5.25' });
    expect(names(res)).toEqual(['Tee']);
  });

  it('price facet is the real displayed min/max in the buyer currency', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const res = await svc.getPublicStoreProducts('s1', US_QUERY);
    // Socks 200 x 0.0035 = 0.70 ... Jacket 5000 x 0.0035 = 17.50
    expect(res.data.facets.price).toEqual({ min: 0.7, max: 17.5, currency: 'USD' });
  });

  it('sorts by displayed price (the fixed-price cap is not the cheapest any more)', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const asc = await svc.getPublicStoreProducts('s1', { ...US_QUERY, sort: 'price_asc' });
    expect(names(asc)).toEqual(['Socks', 'Tee', 'Black Cap', 'Jacket']); // 0.70, 5.25, 9.99, 17.50
    const desc = await svc.getPublicStoreProducts('s1', { ...US_QUERY, sort: 'price_desc' });
    expect(names(desc)).toEqual(['Jacket', 'Black Cap', 'Tee', 'Socks']);
  });

  it('without a market the buyer price is plain FX', async () => {
    const svc = make(null);
    const res = await svc.getPublicStoreProducts('s1', { currency: 'USD', facets: 'true' });
    // 200/280 = 0.71, 5000/280 = 17.86
    expect(res.data.facets.price).toEqual({ min: 0.71, max: 17.86, currency: 'USD' });
  });

  it('the market rule does not apply when the buyer pays in another currency', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const res = await svc.getPublicStoreProducts('s1', { currency: 'EUR', marketId: US_QUERY.marketId, facets: 'true' });
    expect(res.data.facets.price.currency).toBe('EUR');
    expect(res.data.facets.price.min).toBeCloseTo((200 / 280) * 0.92, 2);
  });

  it('keeps the catalogue behaviour when no currency is sent (older storefronts)', async () => {
    const svc = make(US_MARKET, { cap: 9.99 });
    const res = await svc.getPublicStoreProducts('s1', { facets: 'true', minPrice: '900', maxPrice: '1500' });
    expect(names(res).sort()).toEqual(['Black Cap', 'Tee']);
    expect(res.data.facets.price.currency).toBe('PKR');
  });

  it('falls back to catalogue prices when a rate is missing', async () => {
    const svc = make(null, {}, { PKR: 280, USD: 1 });
    const res = await svc.getPublicStoreProducts('s1', { currency: 'EUR', facets: 'true' });
    expect(res.data.facets.price).toEqual({ min: 200, max: 5000, currency: 'PKR' });
  });
});
