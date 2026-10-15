// @ts-nocheck -- jest mock typings only (mongoose Document mocks); the assertions below are real.
import { convertShippingRate, convertFreeShippingThreshold, convertShippingZoneToCurrency, areCurrenciesComparable } from './market-shipping.util';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { ShippingZone } from '@/checkout/shipping.schema';

describe('Market Shipping Utils', () => {
  let exchangeRateService: ExchangeRateService;

  beforeEach(() => {
    exchangeRateService = {
      getCurrentRate: jest.fn(),
    } as any;
  });

  describe('convertShippingRate', () => {
    it('should return same price when currencies match', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate').mockResolvedValue(null);

      const result = await convertShippingRate(100, 'USD', 'USD', 'USD', exchangeRateService);

      expect(result).toBe(100);
      expect(exchangeRateService.getCurrentRate).not.toHaveBeenCalled();
    });

    it('should convert USD to EUR using FX rates', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertShippingRate(100, 'USD', 'USD', 'EUR', exchangeRateService);

      expect(result).toBeCloseTo(85, 2);
    });

    it('should convert EUR to USD using FX rates', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertShippingRate(85, 'EUR', 'USD', 'USD', exchangeRateService);

      expect(result).toBeCloseTo(100, 2);
    });

    it('should use store base currency when shipping currency is null', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertShippingRate(100, null, 'USD', 'EUR', exchangeRateService);

      expect(result).toBeCloseTo(85, 2);
    });

    it('should throw error when FX rate not available', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate').mockResolvedValue(null);

      await expect(convertShippingRate(100, 'XXX', 'USD', 'EUR', exchangeRateService)).rejects.toThrow(
        'Exchange rate not available for XXX',
      );
    });
  });

  describe('convertFreeShippingThreshold', () => {
    it('should return null when threshold is null', async () => {
      const result = await convertFreeShippingThreshold(null, 'USD', 'USD', 'EUR', exchangeRateService);

      expect(result).toBeNull();
    });

    it('should convert threshold to target currency', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertFreeShippingThreshold(100, 'USD', 'USD', 'EUR', exchangeRateService);

      expect(result).toBeCloseTo(85, 2);
    });

    it('should use store base currency when threshold currency is null', async () => {
      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertFreeShippingThreshold(100, null, 'USD', 'EUR', exchangeRateService);

      expect(result).toBeCloseTo(85, 2);
    });
  });

  describe('convertShippingZoneToCurrency', () => {
    it('should convert zone shipping price', async () => {
      const zone: Partial<ShippingZone> = {
        shippingPrice: 100,
        currency: 'USD',
        freeShippingThreshold: null,
        rateTiers: [],
      };

      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertShippingZoneToCurrency(zone as ShippingZone, 'USD', 'EUR', exchangeRateService);

      expect(result.shippingPrice).toBeCloseTo(85, 2);
      expect(result.currency).toBe('EUR');
    });

    it('should convert free-shipping threshold', async () => {
      const zone: Partial<ShippingZone> = {
        shippingPrice: 100,
        currency: 'USD',
        freeShippingThreshold: 200,
        rateTiers: [],
      };

      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertShippingZoneToCurrency(zone as ShippingZone, 'USD', 'EUR', exchangeRateService);

      expect(result.freeShippingThreshold).toBeCloseTo(170, 2);
    });

    it('should convert rate tiers', async () => {
      const zone: Partial<ShippingZone> = {
        shippingPrice: 100,
        currency: 'USD',
        freeShippingThreshold: null,
        rateTiers: [
          { min: 0, max: 10, price: 50 },
          { min: 10, max: null, price: 75 },
        ],
      };

      jest.spyOn(exchangeRateService, 'getCurrentRate')
        .mockImplementation(async (c: string) => (c === 'EUR' ? { currency: 'EUR', ratePerUSD: 0.85, effectiveFrom: new Date(), source: 'provider' } : null));

      const result = await convertShippingZoneToCurrency(zone as ShippingZone, 'USD', 'EUR', exchangeRateService);

      expect(result.rateTiers[0].price).toBeCloseTo(42.5, 2);
      expect(result.rateTiers[1].price).toBeCloseTo(63.75, 2);
    });
  });

  describe('areCurrenciesComparable', () => {
    it('should return true for matching currencies', () => {
      expect(areCurrenciesComparable('USD', 'USD')).toBe(true);
      expect(areCurrenciesComparable('EUR', 'EUR')).toBe(true);
    });

    it('should return false for different currencies', () => {
      expect(areCurrenciesComparable('USD', 'EUR')).toBe(false);
      expect(areCurrenciesComparable('PKR', 'USD')).toBe(false);
    });
  });
});
