import { describe, it, expect } from '@jest/globals';
import { getCurrencyDecimals, getStripeMinorUnitMultiplier, isRealCurrencyCode } from './currency-metadata.const';

describe('CurrencyMetadata', () => {
  describe('getCurrencyDecimals', () => {
    it('should return 0 for zero-decimal currencies', () => {
      expect(getCurrencyDecimals('JPY')).toBe(0);
      expect(getCurrencyDecimals('KRW')).toBe(0);
    });

    it('keeps PKR at its real ISO/Stripe 2 decimals (whole-rupee display is a rounding rule, not metadata)', () => {
      // If this were 0, Stripe charges in PKR would be sent ×1 and bill 1/100 of the price.
      expect(getCurrencyDecimals('PKR')).toBe(2);
      expect(getStripeMinorUnitMultiplier('PKR')).toBe(100);
    });

    it('should return 2 for standard currencies', () => {
      expect(getCurrencyDecimals('USD')).toBe(2);
      expect(getCurrencyDecimals('EUR')).toBe(2);
      expect(getCurrencyDecimals('GBP')).toBe(2);
    });

    it('should return 3 for three-decimal currencies', () => {
      expect(getCurrencyDecimals('KWD')).toBe(3);
      expect(getCurrencyDecimals('BHD')).toBe(3);
      expect(getCurrencyDecimals('OMR')).toBe(3);
    });

    it('should return 2 for unknown currencies', () => {
      expect(getCurrencyDecimals('XYZ')).toBe(2);
    });
  });

  describe('getStripeMinorUnitMultiplier', () => {
    it('should return 1 for zero-decimal currencies', () => {
      expect(getStripeMinorUnitMultiplier('JPY')).toBe(1);
      expect(getStripeMinorUnitMultiplier('KRW')).toBe(1);
    });

    it('should return 100 for standard currencies', () => {
      expect(getStripeMinorUnitMultiplier('USD')).toBe(100);
      expect(getStripeMinorUnitMultiplier('EUR')).toBe(100);
    });

    it('should return 1000 for three-decimal currencies', () => {
      expect(getStripeMinorUnitMultiplier('KWD')).toBe(1000);
      expect(getStripeMinorUnitMultiplier('BHD')).toBe(1000);
    });

    it('should handle case-insensitive codes', () => {
      expect(getStripeMinorUnitMultiplier('usd')).toBe(100);
      expect(getStripeMinorUnitMultiplier('UsD')).toBe(100);
    });
  });

  describe('isRealCurrencyCode', () => {
    it('should return true for valid ISO codes', () => {
      expect(isRealCurrencyCode('USD')).toBe(true);
      expect(isRealCurrencyCode('EUR')).toBe(true);
      expect(isRealCurrencyCode('PKR')).toBe(true);
    });

    it('should return false for invalid codes', () => {
      expect(isRealCurrencyCode('XYZ')).toBe(false);
      expect(isRealCurrencyCode('')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isRealCurrencyCode('usd')).toBe(true);
      expect(isRealCurrencyCode('USD')).toBe(true);
    });
  });
});
