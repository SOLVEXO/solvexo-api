import {
  applyMarketRule,
  marketUnitPrice,
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
    it('applies the market % adjustment whatever the exchange-rate type (Shopify catalog adjustment)', () => {
      expect(applyMarketRule(100, 'USD', { type: 'auto', percentageAdjustment: 10 })).toBeCloseTo(110, 6);
    });
    it('never rounds or adds a fee to a price that was not converted', () => {
      expect(applyMarketRule(100, 'PKR', { useRounding: true, roundingRule: '0.99', conversionFee: 2 }, false)).toBe(100);
      expect(applyMarketRule(100, 'PKR', { percentageAdjustment: 10, useRounding: true }, false)).toBe(110);
    });
    it('PKR has no cents: .99 rounds to whole rupees', () => {
      expect(applyMarketRule(2796.6, 'PKR', { useRounding: true, roundingRule: '0.99' })).toBe(2797);
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
      expect(marketRuleChangesPrice({ type: 'manual' })).toBe(false);
    });
    it('is true when adjustment, fee or rounding is set', () => {
      expect(marketRuleChangesPrice({ type: 'percentage', percentageAdjustment: 5 })).toBe(true);
      expect(marketRuleChangesPrice({ conversionFee: 2 })).toBe(true);
      expect(marketRuleChangesPrice({ useRounding: true })).toBe(true);
      expect(marketRuleChangesPrice({ type: 'auto', percentageAdjustment: 5 })).toBe(true);
      expect(marketRuleChangesPrice({ type: 'manual', manualRate: 0.004 })).toBe(true);
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

  describe('marketUnitPrice (what the storefront shows and checkout charges for ONE unit)', () => {
    it('a fixed market price wins as-is', () => {
      expect(marketUnitPrice(2800, 'PKR', 'USD', { useRounding: true, roundingRule: '0.99', percentageAdjustment: 50 }, SNAPS, 12.5)).toBe(12.5);
    });
    it('uses the seller manual rate instead of the live rate', () => {
      // 1 PKR = 0.004 USD manual -> 2800 PKR = 11.20 USD (live would be 10.00)
      expect(marketUnitPrice(2800, 'PKR', 'USD', { type: 'manual', manualRate: 0.004 }, SNAPS)).toBe(11.2);
    });
    it('rounds the unit, so quantity 3 at .99 is exactly 3 x 9.99', () => {
      const unit = marketUnitPrice(2800, 'PKR', 'USD', { useRounding: true, roundingRule: '0.99' }, SNAPS);
      expect(unit).toBe(9.99);
      const nativeUnit = marketAdjustedNativeAmount(2800, 'PKR', 'USD', { useRounding: true, roundingRule: '0.99' }, SNAPS);
      expect(convertUnrounded(nativeUnit * 3, 'PKR', 'USD', SNAPS)).toBeCloseTo(29.97, 4);
    });
    it('nearest rounding keeps cents in a 2-decimal currency', () => {
      expect(marketUnitPrice(2931.6, 'PKR', 'USD', { useRounding: true, roundingRule: 'nearest' }, SNAPS)).toBe(10.47);
    });
    it('the store currency market is never rounded', () => {
      expect(marketUnitPrice(1234, 'PKR', 'PKR', { useRounding: true, roundingRule: '1.00' }, SNAPS)).toBe(1234);
    });
  });
});
