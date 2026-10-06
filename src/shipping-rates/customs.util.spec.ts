import {
  buildShippoCustomsItem, findMissingCustoms, isInternationalDestination, missingCustomsMessage,
  normalizeCountryOfOrigin, normalizeHsCode, parseCustomsInput, shouldShowDutiesNotice, CustomsLine,
} from './customs.util';

const line = (over: Partial<CustomsLine> = {}): CustomsLine => ({
  name: 'Linen shirt', quantity: 2, value: 59.98, netWeightKg: 0.8,
  countryOfOrigin: 'PK', hsCode: '6205.20', customsDescription: null, ...over,
});

describe('customs.util', () => {
  it('normalizes country of origin to upper-case ISO-2', () => {
    expect(normalizeCountryOfOrigin(' pk ')).toBe('PK');
    expect(normalizeCountryOfOrigin('Pakistan')).toBeNull();
    expect(normalizeCountryOfOrigin(5)).toBeNull();
  });

  it('accepts 6-10 digit HS codes with dots and rejects the rest', () => {
    expect(normalizeHsCode('6109.10')).toBe('6109.10');
    expect(normalizeHsCode('6109 10 00')).toBe('61091000');
    expect(normalizeHsCode('61091')).toBeNull();
    expect(normalizeHsCode('61091000123')).toBeNull();
    expect(normalizeHsCode('61AB10')).toBeNull();
  });

  it('parseCustomsInput leaves absent keys alone, clears blanks and reports invalid values', () => {
    expect(parseCustomsInput({}).value).toEqual({});
    expect(parseCustomsInput({ countryOfOrigin: '', hsCode: null }).value).toEqual({ countryOfOrigin: null, hsCode: null });
    expect(parseCustomsInput({ countryOfOrigin: 'us', hsCode: '6109.10' }).value).toEqual({ countryOfOrigin: 'US', hsCode: '6109.10' });
    expect(parseCustomsInput({ countryOfOrigin: 'USA' }).error).toMatch(/origin/i);
    expect(parseCustomsInput({ hsCode: '12' }).error).toMatch(/HS code/);
  });

  it('detects international destinations (unknown country is not international)', () => {
    expect(isInternationalDestination('PK', 'US')).toBe(true);
    expect(isInternationalDestination('pk', 'PK')).toBe(false);
    expect(isInternationalDestination('PK', null)).toBe(false);
    expect(isInternationalDestination('PK', 'Pakistan')).toBe(false);
  });

  it('names every product that lacks customs data', () => {
    const missing = findMissingCustoms([line(), line({ name: 'Scarf', hsCode: null }), line({ name: 'Cap', countryOfOrigin: null, hsCode: null })]);
    expect(missing).toEqual([
      { name: 'Scarf', missing: ['HS code'] },
      { name: 'Cap', missing: ['country of origin', 'HS code'] },
    ]);
    const msg = missingCustomsMessage(missing);
    expect(msg).toContain('"Scarf" (HS code)');
    expect(msg).toContain('"Cap" (country of origin and HS code)');
  });

  it('builds a Shippo customs item', () => {
    expect(buildShippoCustomsItem(line(), 'USD')).toEqual({
      description: 'Linen shirt', quantity: 2, net_weight: '0.8', mass_unit: 'kg',
      value_amount: '59.98', value_currency: 'USD', origin_country: 'PK', tariff_number: '6205.20',
    });
    expect(buildShippoCustomsItem(line({ customsDescription: 'Cotton shirt' }), 'USD').description).toBe('Cotton shirt');
  });

  it('shows the duties notice only for international destinations unless switched off', () => {
    expect(shouldShowDutiesNotice('PK', 'US', undefined)).toBe(true);
    expect(shouldShowDutiesNotice('PK', 'US', true)).toBe(true);
    expect(shouldShowDutiesNotice('PK', 'US', false)).toBe(false);
    expect(shouldShowDutiesNotice('PK', 'PK', true)).toBe(false);
  });
});
