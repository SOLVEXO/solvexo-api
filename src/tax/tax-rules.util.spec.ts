/* eslint-disable prettier/prettier */
import {
  collectionIdsForProduct, findTaxOverride, parseTaxOverrides, pricesIncludeTaxFor, resolveItemTaxRate, splitLineTax,
} from './tax-rules.util';

describe('splitLineTax', () => {
  it('exclusive: tax is added on top', () => {
    expect(splitLineTax(100, 10, false)).toEqual({ added: 10, included: 0 });
  });
  it('inclusive: tax is extracted from the gross price (110 @10% -> 10), never added', () => {
    expect(splitLineTax(110, 10, true)).toEqual({ added: 0, included: 10 });
    expect(splitLineTax(100, 15, true)).toEqual({ added: 0, included: 13.04 });
  });
  it('zero rate / zero price = no tax', () => {
    expect(splitLineTax(100, 0, true)).toEqual({ added: 0, included: 0 });
    expect(splitLineTax(0, 10, false)).toEqual({ added: 0, included: 0 });
  });
  it('gross - included tax = net price (within a cent)', () => {
    const { included } = splitLineTax(19.99, 17.5, true);
    expect(Math.abs(19.99 - included - 19.99 / 1.175)).toBeLessThan(0.006);
  });
});

describe('pricesIncludeTaxFor', () => {
  const regions = [
    { country: 'GB', state: null, rate: 20, pricesIncludeTax: true },
    { country: 'US', state: 'CA', rate: 7.25, pricesIncludeTax: false },
    { country: 'PK', state: null, rate: 17 },
  ];
  it('follows the store-wide setting when a region has no explicit value', () => {
    expect(pricesIncludeTaxFor({ taxPricesIncludeTax: true, taxRegions: regions }, { country: 'pk' })).toBe(true);
    expect(pricesIncludeTaxFor({ taxPricesIncludeTax: false, taxRegions: regions }, { country: 'PK' })).toBe(false);
  });
  it('a region explicit true/false beats the store setting', () => {
    expect(pricesIncludeTaxFor({ taxPricesIncludeTax: false, taxRegions: regions }, { country: 'GB' })).toBe(true);
    expect(pricesIncludeTaxFor({ taxPricesIncludeTax: true, taxRegions: regions }, { country: 'US', state: 'ca' })).toBe(false);
  });
  it('no address (digital cart) uses the store setting', () => {
    expect(pricesIncludeTaxFor({ taxPricesIncludeTax: true, taxRegions: regions }, null)).toBe(true);
  });
});

describe('tax overrides + taxable flag', () => {
  const cfg = {
    taxRate: 10,
    taxRegions: [{ country: 'US', state: null, rate: 8 }],
    taxOverrides: [
      { id: 'o1', name: 'Books', country: null, state: null, rate: 0, collectionIds: ['c-books'], categoryIds: [] },
      { id: 'o2', name: 'Food CA', country: 'US', state: 'CA', rate: 2, collectionIds: [], categoryIds: ['cat-food'] },
      { id: 'o3', name: 'Food US', country: 'US', state: null, rate: 3, collectionIds: [], categoryIds: ['cat-food'] },
    ],
  };
  it('non-taxable variant is never taxed', () => {
    expect(resolveItemTaxRate(cfg, { country: 'US' }, { taxable: false })).toBe(0);
  });
  it('no override -> region rate, else flat rate', () => {
    expect(resolveItemTaxRate(cfg, { country: 'US' }, { taxable: true })).toBe(8);
    expect(resolveItemTaxRate(cfg, { country: 'PK' }, {})).toBe(10);
  });
  it('collection override applies everywhere when it has no geography', () => {
    expect(resolveItemTaxRate(cfg, { country: 'PK' }, { collectionIds: ['c-books'] })).toBe(0);
  });
  it('most specific geography wins (state > country)', () => {
    expect(findTaxOverride(cfg, { country: 'US', state: 'CA' }, { categoryId: 'cat-food' })?.id).toBe('o2');
    expect(findTaxOverride(cfg, { country: 'US', state: 'NY' }, { categoryId: 'cat-food' })?.id).toBe('o3');
    expect(findTaxOverride(cfg, { country: 'PK' }, { categoryId: 'cat-food' })).toBeNull();
  });
});

describe('collectionIdsForProduct', () => {
  const cols = [
    { _id: 'm1', type: 'manual', productIds: ['p1'] },
    { _id: 'a1', type: 'automatic', rules: { categoryId: 'cat1', tags: [], matchType: 'any' as const } },
    { _id: 'a2', type: 'automatic', rules: { categoryId: 'cat1', tags: ['sale'], matchType: 'all' as const } },
    { _id: 'a3', type: 'automatic', rules: { categoryId: null, tags: ['sale', 'new'], matchType: 'any' as const } },
  ];
  it('matches manual lists and automatic rules', () => {
    expect(collectionIdsForProduct({ id: 'p1', categoryId: 'cat1', tags: ['Sale'] }, cols).sort()).toEqual(['a1', 'a2', 'a3', 'm1']);
    expect(collectionIdsForProduct({ id: 'p9', categoryId: 'cat1', tags: [] }, cols)).toEqual(['a1']);
  });
});

describe('parseTaxOverrides', () => {
  it('validates and normalises', () => {
    const out = parseTaxOverrides([{ name: ' Books ', rate: 0, collectionIds: ['c1', 'c1'], country: 'US', state: 'CA' }]);
    expect(out[0]).toMatchObject({ name: 'Books', rate: 0, collectionIds: ['c1'], categoryIds: [], country: 'US', state: 'CA' });
    expect(out[0].id).toBeTruthy();
  });
  it('rejects bad rate and empty targets', () => {
    expect(() => parseTaxOverrides([{ rate: 120, collectionIds: ['c'] }])).toThrow();
    expect(() => parseTaxOverrides([{ rate: 5 }])).toThrow(/collection or category/);
    expect(() => parseTaxOverrides('x')).toThrow();
  });
});
