import { browseDisplayPrice, priceInRange, type BrowsePriceContext } from './browse-price.util';

const SNAPS = [
  { currency: 'PKR', ratePerUSD: 280 },
  { currency: 'EUR', ratePerUSD: 0.92 },
  { currency: 'AED', ratePerUSD: 3.67 },
];

const fixedMap = (entries: Array<[string, string | null, number]>) =>
  new Map(entries.map(([p, v, price]) => [`${p}:${v ?? ''}`, { productId: p, variantId: v, fixedPrice: price, compareAtPrice: null }]));

const ctx = (over: Partial<BrowsePriceContext>): BrowsePriceContext => ({
  nativeCurrency: 'PKR',
  buyerCurrency: 'PKR',
  market: null,
  fixed: new Map(),
  snapshots: SNAPS,
  ...over,
});

describe('browseDisplayPrice (what the storefront card shows)', () => {
  it('shows the catalogue price untouched in the store currency', () => {
    expect(browseDisplayPrice(900, 'p', 'v', ctx({}))).toBe(900);
  });

  it('plain FX in a currency with no market rule, rounded to the currency precision', () => {
    // 900 PKR / 280 = 3.2142857 USD
    expect(browseDisplayPrice(900, 'p', 'v', ctx({ buyerCurrency: 'USD' }))).toBe(3.21);
  });

  it('manual rate market: 900 PKR x 0.0035 = 3.15 (not the FX 3.21)', () => {
    const market = { currency: 'USD', pricingRule: { type: 'manual', manualRate: 0.0035 } };
    expect(browseDisplayPrice(900, 'p', 'v', ctx({ buyerCurrency: 'USD', market }))).toBe(3.15);
  });

  it('a fixed market price wins as-is, even above the converted price', () => {
    const market = { currency: 'USD', pricingRule: { type: 'manual', manualRate: 0.0035 } };
    const fixed = fixedMap([['cap', 'v1', 9.99]]);
    expect(browseDisplayPrice(900, 'cap', 'v1', ctx({ buyerCurrency: 'USD', market, fixed }))).toBe(9.99);
    // another product is not affected
    expect(browseDisplayPrice(1500, 'tee', 'v2', ctx({ buyerCurrency: 'USD', market, fixed }))).toBe(5.25);
  });

  it('a product-wide fixed price applies to any variant', () => {
    const market = { currency: 'USD', pricingRule: { type: 'auto' } };
    const fixed = fixedMap([['cap', null, 12.5]]);
    expect(browseDisplayPrice(900, 'cap', 'any', ctx({ buyerCurrency: 'USD', market, fixed }))).toBe(12.5);
  });

  it('conversion fee + .99 rounding market', () => {
    const market = { currency: 'EUR', pricingRule: { type: 'percentage', percentageAdjustment: 0, conversionFee: 3, useRounding: true, roundingRule: '0.99' } };
    // 900 PKR = 2.9571 EUR; +3% = 3.0458; nearest .99 = 2.99
    expect(browseDisplayPrice(900, 'p', 'v', ctx({ buyerCurrency: 'EUR', market }))).toBe(2.99);
  });

  it('the market rule is ignored when the buyer pays in another currency', () => {
    const market = { currency: 'USD', pricingRule: { type: 'manual', manualRate: 0.0035 } };
    const fixed = fixedMap([['cap', 'v1', 9.99]]);
    expect(browseDisplayPrice(900, 'cap', 'v1', ctx({ buyerCurrency: 'EUR', market, fixed }))).toBe(2.96);
  });

  it('same-currency market with a percentage adjustment still moves the price', () => {
    const market = { currency: 'PKR', pricingRule: { type: 'percentage', percentageAdjustment: 10 } };
    expect(browseDisplayPrice(1000, 'p', 'v', ctx({ market }))).toBe(1100);
  });
});

describe('priceInRange', () => {
  it('is inclusive on both edges', () => {
    expect(priceInRange(9.99, 9.99, 9.99)).toBe(true);
    expect(priceInRange(5.25, 5.25, 10)).toBe(true);
    expect(priceInRange(10, 5, 10)).toBe(true);
  });
  it('excludes outside values and handles open ends', () => {
    expect(priceInRange(4.99, 5, null)).toBe(false);
    expect(priceInRange(10.01, null, 10)).toBe(false);
    expect(priceInRange(1000, null, null)).toBe(true);
  });
});
