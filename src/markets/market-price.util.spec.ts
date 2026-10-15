import {
  applyMarketRule,
  convertUnrounded,
  marketAdjustedNativeAmount,
  marketRuleChangesPrice,
  normalizeCountryCode,
  normalizeLocale,
  pickMarketForCountry,
} from './market-price.util';

// ratePerUSD = units of the currency per 1 USD
const SNAPS = [
  { currency: 'PKR', ratePerUSD: 280 },
  { currency: 'EUR', ratePerUSD: 0.9 },
  { currency: 'JPY', ratePerUSD: 150 },
];

describe('market-price.util', () => {
  describe('normalisers', () => {
    it('accepts only ISO alpha-2 countries', () => {
      expect(normalizeCountryCode(' pk ')).toBe('PK');
      expect(normalizeCountryCode('PAK')).toBeNull();
      expect(normalizeCountryCode({ $ne: 1 })).toBeNull();
      expect(normalizeCountryCode(undefined)).toBeNull();
    });
    it('accepts short locales only', () => {
      expect(normalizeLocale('UR')).toBe('ur');
      expect(normalizeLocale('pt-BR')).toBe('pt-br');
      expect(normalizeLocale('../etc')).toBeNull();
      expect(normalizeLocale(5)).toBeNull();
    });
  });

  describe('pickMarketForCountry', () => {
    const pk = { name: 'pk', countries: ['PK'], isActive: true, isPrimary: true };
    const eu = { name: 'eu', countries: ['DE', 'FR'], isActive: true, isPrimary: false };
    const off = { name: 'off', countries: ['US'], isActive: false, isPrimary: false };
    const gone = { name: 'gone', countries: ['US'], isActive: true, isDelete: true };

    it('matches by country', () => expect(pickMarketForCountry([pk, eu], 'de')?.name).toBe('eu'));
    it('falls back to the primary market', () => expect(pickMarketForCountry([pk, eu], 'BR')?.name).toBe('pk'));
    it('ignores inactive and deleted markets', () => expect(pickMarketForCountry([off, gone, pk], 'US')?.name).toBe('pk'));
    it('returns null when nothing matches and there is no primary', () => expect(pickMarketForCountry([eu], 'BR')).toBeNull());
    it('uses the primary market when the country is unknown', () => expect(pickMarketForCountry([pk, eu], null)?.name).toBe('pk'));
  });

  describe('applyMarketRule', () => {
    it('leaves the amount alone with no rule', () => expect(applyMarketRule(10.123, 'USD', null)).toBe(10.123));
    it('applies a percentage adjustment', () => {
      expect(applyMarketRule(100, 'USD', { type: 'percentage', percentageAdjustment: 10 })).toBeCloseTo(110, 6);
      expect(applyMarketRule(100, 'USD', { type: 'percentage', percentageAdjustment: -5 })).toBeCloseTo(95, 6);
    });
    it('ignores percentageAdjustment unless the rule type is percentage', () => {
      expect(applyMarketRule(100, 'USD', { type: 'auto', percentageAdjustment: 10 })).toBe(100);
    });
    it('applies fee then rounding in the market currency', () => {
      expect(applyMarketRule(100, 'USD', { type: 'auto', conversionFee: 1.5, useRounding: true, roundingRule: '0.99' })).toBe(101.99);
    });
    it('rounds to whole units with 1.00', () => {
      expect(applyMarketRule(2796.6, 'PKR', { useRounding: true, roundingRule: '1.00' })).toBe(2797);
    });
    it('falls back to nearest for zero-decimal currencies with .99', () => {
      expect(applyMarketRule(1234.4, 'JPY', { useRounding: true, roundingRule: '0.99' })).toBe(1234);
    });
    it('treats an unknown rounding rule as nearest', () => {
      expect(applyMarketRule(10.126, 'USD', { useRounding: true, roundingRule: 'weird' })).toBe(10.13);
    });
  });

  describe('marketRuleChangesPrice', () => {
    it('is false for plain FX markets', () => {
      expect(marketRuleChangesPrice(null)).toBe(false);
      expect(marketRuleChangesPrice({ type: 'auto' })).toBe(false);
      expect(marketRuleChangesPrice({ type: 'manual', percentageAdjustment: 5 })).toBe(false);
    });
    it('is true when adjustment, fee or rounding is set', () => {
      expect(marketRuleChangesPrice({ type: 'percentage', percentageAdjustment: 5 })).toBe(true);
      expect(marketRuleChangesPrice({ conversionFee: 2 })).toBe(true);
      expect(marketRuleChangesPrice({ useRounding: true })).toBe(true);
    });
  });

  describe('convertUnrounded', () => {
    it('uses the USD pivot with ratePerUSD = units per USD', () => {
      expect(convertUnrounded(2800, 'PKR', 'USD', SNAPS)).toBeCloseTo(10, 9);
      expect(convertUnrounded(10, 'USD', 'PKR', SNAPS)).toBeCloseTo(2800, 9);
      expect(convertUnrounded(2800, 'PKR', 'EUR', SNAPS)).toBeCloseTo(9, 9);
    });
    it('is the identity for the same currency', () => expect(convertUnrounded(5, 'PKR', 'PKR', SNAPS)).toBe(5));
    it('throws when a rate is missing', () => expect(() => convertUnrounded(1, 'PKR', 'XXX', SNAPS)).toThrow());
  });

  describe('marketAdjustedNativeAmount', () => {
    it('lands on the exact rounded market price once converted back (PKR store, USD market, .99)', () => {
      const native = marketAdjustedNativeAmount(2800, 'PKR', 'USD', { useRounding: true, roundingRule: '0.99' }, SNAPS);
      // 2800 PKR = 10.00 USD -> nearest .99 = 9.99 USD
      expect(convertUnrounded(native, 'PKR', 'USD', SNAPS)).toBeCloseTo(9.99, 4);
    });
    it('keeps the price when the rule changes nothing', () => {
      expect(marketAdjustedNativeAmount(1234.5, 'PKR', 'USD', { type: 'auto' }, SNAPS)).toBeCloseTo(1234.5, 5);
    });
    it('applies a percentage on top of the FX price', () => {
      const native = marketAdjustedNativeAmount(2800, 'PKR', 'EUR', { type: 'percentage', percentageAdjustment: 10 }, SNAPS);
      expect(convertUnrounded(native, 'PKR', 'EUR', SNAPS)).toBeCloseTo(9.9, 4);
    });
    it('is a no-op for a market in the store currency', () => {
      expect(marketAdjustedNativeAmount(100, 'PKR', 'PKR', { useRounding: true, roundingRule: '1.00' }, SNAPS)).toBe(100);
    });
  });
});
