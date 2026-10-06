import { cleanPostalCodes, meetsMinOrderAmount, normalizePostcode, postcodeMatch } from './shipping-zone-match.util';
import { resolveRegionRate, shippingTaxFromRate } from '@/tax/shipping-tax.util';

describe('shipping-zone-match.util', () => {
  it('normalises postcodes', () => {
    expect(normalizePostcode(' sw1a-1aa ')).toBe('SW1A1AA');
    expect(cleanPostalCodes(['54000', '54 000', '', 'abc'])).toEqual(['54000', 'ABC']);
  });
  it('postcodeMatch: null without list, exact otherwise', () => {
    expect(postcodeMatch({ postalCodes: [] }, '54000')).toBeNull();
    expect(postcodeMatch({ postalCodes: ['54000'] }, '54 000')).toBe(true);
    expect(postcodeMatch({ postalCodes: ['54000'] }, '54001')).toBe(false);
    expect(postcodeMatch({ postalCodes: ['54000'] }, null)).toBe(false);
  });
  it('meetsMinOrderAmount', () => {
    expect(meetsMinOrderAmount({}, 0)).toBe(true);
    expect(meetsMinOrderAmount({ minOrderAmount: 50 }, 49.99)).toBe(false);
    expect(meetsMinOrderAmount({ minOrderAmount: 50 }, 50)).toBe(true);
  });
});

describe('shipping-tax.util', () => {
  const regions = [{ country: 'US', state: 'CA', rate: 8 }, { country: 'US', state: null, rate: 5 }];
  it('resolves region rate by state then country', () => {
    expect(resolveRegionRate(regions, { country: 'us', state: 'ca' })).toBe(8);
    expect(resolveRegionRate(regions, { country: 'US', state: 'NY' })).toBe(5);
    expect(resolveRegionRate(regions, { country: 'PK' })).toBeNull();
  });
  it('taxes shipping only when enabled', () => {
    expect(shippingTaxFromRate(10, 10, false)).toBe(0);
    expect(shippingTaxFromRate(10, 10, true)).toBe(1);
    expect(shippingTaxFromRate(0, 10, true)).toBe(0);
  });
});
