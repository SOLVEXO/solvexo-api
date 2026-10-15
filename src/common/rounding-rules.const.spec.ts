import { applyRounding, applyConversionFee, calculateFinalPrice, getDefaultRoundingRule } from './rounding-rules.const';

describe('Rounding Rules', () => {
  describe('getDefaultRoundingRule', () => {
    it('should return default rule for USD', () => {
      expect(getDefaultRoundingRule('USD')).toBe('0.99');
    });

    it('should return default rule for EUR', () => {
      expect(getDefaultRoundingRule('EUR')).toBe('0.95');
    });

    it('should return default rule for JPY', () => {
      expect(getDefaultRoundingRule('JPY')).toBe('1.00');
    });

    it('should return nearest for unknown currency', () => {
      expect(getDefaultRoundingRule('XXX')).toBe('nearest');
    });
  });

  describe('applyRounding', () => {
    describe('0.95 rule', () => {
      it('should round down to .95', () => {
        expect(applyRounding(10.99, 'USD', '0.95')).toBe(10.95);
        expect(applyRounding(10.97, 'USD', '0.95')).toBe(10.95);
        expect(applyRounding(10.50, 'USD', '0.95')).toBe(10.95);
      });

      it('should keep .95 as is', () => {
        expect(applyRounding(10.95, 'USD', '0.95')).toBe(10.95);
      });
    });

    describe('0.99 rule', () => {
      it('should round down to .99', () => {
        expect(applyRounding(10.95, 'USD', '0.99')).toBe(10.99);
        expect(applyRounding(10.50, 'USD', '0.99')).toBe(10.99);
      });

      it('should keep .99 as is', () => {
        expect(applyRounding(10.99, 'USD', '0.99')).toBe(10.99);
      });
    });

    describe('1.00 rule', () => {
      it('should round to nearest whole number', () => {
        expect(applyRounding(10.50, 'USD', '1.00')).toBe(11);
        expect(applyRounding(10.49, 'USD', '1.00')).toBe(10);
        expect(applyRounding(10.99, 'USD', '1.00')).toBe(11);
      });
    });

    describe('nearest rule', () => {
      it('should round to nearest decimal place for 2-decimal currencies', () => {
        expect(applyRounding(10.995, 'USD', 'nearest')).toBe(11.00);
        expect(applyRounding(10.994, 'USD', 'nearest')).toBe(10.99);
      });

      it('should round to nearest whole number for 0-decimal currencies', () => {
        expect(applyRounding(10.5, 'JPY', 'nearest')).toBe(11);
        expect(applyRounding(10.4, 'JPY', 'nearest')).toBe(10);
      });

      it('should round to nearest 0.001 for 3-decimal currencies', () => {
        expect(applyRounding(10.0005, 'KWD', 'nearest')).toBe(10.001);
        expect(applyRounding(10.0004, 'KWD', 'nearest')).toBe(10.000);
      });
    });
  });

  describe('applyConversionFee', () => {
    it('should add 1.5% fee', () => {
      expect(applyConversionFee(100, 1.5)).toBe(101.5);
    });

    it('should add 2% fee', () => {
      expect(applyConversionFee(100, 2)).toBe(102);
    });

    it('should return same price with 0% fee', () => {
      expect(applyConversionFee(100, 0)).toBe(100);
    });

    it('should return same price with null fee', () => {
      expect(applyConversionFee(100, null)).toBe(100);
    });

    it('should handle negative fee (discount)', () => {
      expect(applyConversionFee(100, -5)).toBe(95);
    });
  });

  describe('calculateFinalPrice', () => {
    it('should apply only rounding', () => {
      const result = calculateFinalPrice(10.99, 'USD', null, '0.95');
      expect(result).toBe(10.95);
    });

    it('should apply only conversion fee', () => {
      const result = calculateFinalPrice(100, 'USD', 1.5, 'nearest');
      expect(result).toBe(101.5);
    });

    it('should apply both fee and rounding', () => {
      const result = calculateFinalPrice(100, 'USD', 1.5, '0.99');
      expect(result).toBe(101.99);
    });

    it('should use default rounding rule when not specified', () => {
      const result = calculateFinalPrice(10.95, 'USD', null, null);
      expect(result).toBe(10.99); // USD default is 0.99
    });

    it('should return same price when no fee and the nearest rule is chosen', () => {
      const result = calculateFinalPrice(100, 'USD', null, 'nearest');
      expect(result).toBeCloseTo(100, 2);
    });

    it('should not raise a whole price by almost a unit with the .99 ending', () => {
      expect(applyRounding(10, 'USD', '0.99')).toBe(9.99);
      expect(applyRounding(10.01, 'USD', '0.99')).toBe(9.99);
      expect(applyRounding(0.3, 'USD', '0.99')).toBe(0.99);
      expect(applyRounding(10, 'USD', '0.95')).toBe(9.95);
    });

    it('should fall back to nearest for currencies that are not 2-decimal', () => {
      expect(applyRounding(1234.4, 'JPY', '0.99')).toBe(1234);
      expect(applyRounding(10.0004, 'KWD', '0.95')).toBe(10);
    });
  });
});
