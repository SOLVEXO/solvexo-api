import { getCurrencyDecimals } from './currency-metadata.const';

/**
 * Rounding rule types.
 * - 0.95: Nearest price ending in .95 (10.00 → 9.95, 10.50 → 10.95, 10.99 → 10.95)
 * - 0.99: Nearest price ending in .99 (10.00 → 9.99, 10.50 → 10.99, 10.97 → 10.99)
 * - 1.00: Round to nearest whole number (e.g., 10.50 → 11)
 * - nearest: Round to nearest decimal place based on currency
 *
 * The .95/.99 endings only make sense for 2-decimal currencies; every other
 * currency (JPY, KWD…) falls back to `nearest`. The storefront has a mirror of
 * this math (`solvexo-web/src/utils/marketPricing.ts`) — keep them identical.
 */
export type RoundingRule = '0.95' | '0.99' | '1.00' | 'nearest';

/**
 * Default rounding rules per currency.
 * Merchants can override these per market.
 */
export const DEFAULT_ROUNDING_RULES: Record<string, RoundingRule> = {
  USD: '0.99',
  EUR: '0.95',
  GBP: '0.99',
  CAD: '0.99',
  AUD: '0.99',
  JPY: '1.00', // Zero-decimal currencies always round to whole numbers
  KRW: '1.00',
  PKR: '1.00', // Whole numbers for PKR
  KWD: '1.00', // Three-decimal currencies round to whole units
  BHD: '1.00',
  IQD: '1.00',
  JOD: '1.00',
  LYD: '1.00',
  OMR: '1.00',
  TND: '1.00',
};

/**
 * Get the default rounding rule for a currency.
 * Falls back to 'nearest' if currency not in defaults.
 */
export function getDefaultRoundingRule(currency: string): RoundingRule {
  return DEFAULT_ROUNDING_RULES[currency] || 'nearest';
}

/**
 * Apply rounding to a price based on the rule.
 *
 * @param price - The price to round
 * @param currency - The currency code (for decimal places)
 * @param rule - The rounding rule to apply
 * @returns The rounded price
 */
export function applyRounding(price: number, currency: string, rule: RoundingRule): number {
  const decimals = getCurrencyDecimals(currency);
  const multiplier = Math.pow(10, decimals);
  const nearest = () => Math.round(price * multiplier) / multiplier;

  switch (rule) {
    case '0.95':
    case '0.99': {
      if (decimals !== 2) return nearest();
      const ending = rule === '0.95' ? 0.95 : 0.99;
      const whole = Math.max(0, Math.round(price - ending));
      return Math.round((whole + ending) * 100) / 100;
    }

    case '1.00':
      // Round to nearest whole number
      return Math.round(price);

    case 'nearest':
    default:
      // Round to nearest decimal place based on currency
      return nearest();
  }
}

/**
 * Apply conversion fee to a price.
 *
 * @param price - The base price
 * @param feePercent - The fee percentage (e.g., 1.5 for 1.5%)
 * @returns Price with fee added
 */
export function applyConversionFee(price: number, feePercent: number | null): number {
  if (feePercent === null || feePercent === 0) {
    return price;
  }
  // Rounded to 8 places so 100 * (1 + 1.5/100) is 101.5, not 101.49999999999999.
  return Math.round(price * (1 + feePercent / 100) * 1e8) / 1e8;
}

/**
 * Calculate final price with optional conversion fee and rounding.
 *
 * @param basePrice - The base price
 * @param currency - The currency code
 * @param feePercent - Optional conversion fee percentage
 * @param roundingRule - Optional rounding rule (defaults to currency default)
 * @returns Final price with fee and rounding applied
 */
export function calculateFinalPrice(
  basePrice: number,
  currency: string,
  feePercent: number | null = null,
  roundingRule: RoundingRule | null = null,
): number {
  let price = basePrice;

  // Apply conversion fee
  if (feePercent !== null && feePercent !== 0) {
    price = applyConversionFee(price, feePercent);
  }

  // Apply rounding
  const rule = roundingRule || getDefaultRoundingRule(currency);
  price = applyRounding(price, currency, rule);

  return price;
}
