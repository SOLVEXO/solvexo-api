import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { ShippingZone } from '@/checkout/shipping.schema';

/**
 * Convert a shipping rate to the target currency using FX rates.
 *
 * @param shippingPrice - The shipping price in its original currency
 * @param shippingCurrency - The currency of the shipping rate (null = store base currency)
 * @param storeBaseCurrency - The store's base currency
 * @param targetCurrency - The target currency (checkout currency)
 * @param exchangeRateService - Exchange rate service for FX conversion
 * @returns The converted shipping price in target currency
 */
export async function convertShippingRate(
  shippingPrice: number,
  shippingCurrency: string | null,
  storeBaseCurrency: string,
  targetCurrency: string,
  exchangeRateService: ExchangeRateService,
): Promise<number> {
  // If no currency specified, assume store base currency
  const sourceCurrency = shippingCurrency || storeBaseCurrency;

  // If already in target currency, no conversion needed
  if (sourceCurrency === targetCurrency) {
    return shippingPrice;
  }

  // Convert using USD as pivot
  const sourceRate = await exchangeRateService.getCurrentRate(sourceCurrency);
  const targetRate = await exchangeRateService.getCurrentRate(targetCurrency);

  if (!sourceRate && sourceCurrency !== 'USD') {
    throw new Error(`Exchange rate not available for ${sourceCurrency}`);
  }
  if (!targetRate && targetCurrency !== 'USD') {
    throw new Error(`Exchange rate not available for ${targetCurrency}`);
  }

  // Convert: sourceCurrency -> USD -> targetCurrency
  const sourceToUsd = sourceCurrency === 'USD' ? 1 : sourceRate!.ratePerUSD;
  const usdToTarget = targetCurrency === 'USD' ? 1 : targetRate!.ratePerUSD;

  return shippingPrice / sourceToUsd * usdToTarget;
}

/**
 * Convert a free-shipping threshold to the target currency.
 *
 * @param threshold - The threshold in its original currency
 * @param thresholdCurrency - The currency of the threshold (null = store base currency)
 * @param storeBaseCurrency - The store's base currency
 * @param targetCurrency - The target currency (checkout currency)
 * @param exchangeRateService - Exchange rate service for FX conversion
 * @returns The converted threshold in target currency
 */
export async function convertFreeShippingThreshold(
  threshold: number | null,
  thresholdCurrency: string | null,
  storeBaseCurrency: string,
  targetCurrency: string,
  exchangeRateService: ExchangeRateService,
): Promise<number | null> {
  if (threshold === null) {
    return null;
  }

  // If no currency specified, assume store base currency
  const sourceCurrency = thresholdCurrency || storeBaseCurrency;

  // If already in target currency, no conversion needed
  if (sourceCurrency === targetCurrency) {
    return threshold;
  }

  // Convert using USD as pivot
  const sourceRate = await exchangeRateService.getCurrentRate(sourceCurrency);
  const targetRate = await exchangeRateService.getCurrentRate(targetCurrency);

  if (!sourceRate && sourceCurrency !== 'USD') {
    throw new Error(`Exchange rate not available for ${sourceCurrency}`);
  }
  if (!targetRate && targetCurrency !== 'USD') {
    throw new Error(`Exchange rate not available for ${targetCurrency}`);
  }

  // Convert: sourceCurrency -> USD -> targetCurrency
  const sourceToUsd = sourceCurrency === 'USD' ? 1 : sourceRate!.ratePerUSD;
  const usdToTarget = targetCurrency === 'USD' ? 1 : targetRate!.ratePerUSD;

  return threshold / sourceToUsd * usdToTarget;
}

/**
 * Convert a shipping zone's rates to the target currency.
 * This converts both the shipping price and free-shipping threshold.
 *
 * @param zone - The shipping zone
 * @param storeBaseCurrency - The store's base currency
 * @param targetCurrency - The target currency (checkout currency)
 * @param exchangeRateService - Exchange rate service for FX conversion
 * @returns The zone with converted prices
 */
export async function convertShippingZoneToCurrency(
  zone: ShippingZone,
  storeBaseCurrency: string,
  targetCurrency: string,
  exchangeRateService: ExchangeRateService,
): Promise<ShippingZone> {
  const convertedZone = { ...zone };

  // Convert shipping price
  convertedZone.shippingPrice = await convertShippingRate(
    zone.shippingPrice,
    zone.currency || null,
    storeBaseCurrency,
    targetCurrency,
    exchangeRateService,
  );

  // Convert free-shipping threshold
  if (zone.freeShippingThreshold !== null) {
    convertedZone.freeShippingThreshold = await convertFreeShippingThreshold(
      zone.freeShippingThreshold,
      zone.currency || null,
      storeBaseCurrency,
      targetCurrency,
      exchangeRateService,
    );
  }

  // Convert rate tiers if present
  if (zone.rateTiers && zone.rateTiers.length > 0) {
    convertedZone.rateTiers = await Promise.all(
      zone.rateTiers.map(async (tier) => ({
        ...tier,
        price: await convertShippingRate(
          tier.price,
          zone.currency || null,
          storeBaseCurrency,
          targetCurrency,
          exchangeRateService,
        ),
      })),
    );
  }

  // Update currency field to target currency
  convertedZone.currency = targetCurrency;

  return convertedZone;
}

/**
 * Check if two monetary values are comparable (same currency).
 * Used to prevent cross-currency comparisons without conversion.
 *
 * @param currency1 - First currency
 * @param currency2 - Second currency
 * @returns True if currencies match
 */
export function areCurrenciesComparable(currency1: string, currency2: string): boolean {
  return currency1 === currency2;
}
