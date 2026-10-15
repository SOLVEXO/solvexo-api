import { applyConversionFee, applyRounding, RoundingRule } from '@/common/rounding-rules.const';
import { getCurrencyDecimals } from '@/common/currency-metadata.const';

/** The pricing part of a Market (see schemas/market.schema.ts `pricingRule`). */
export interface MarketPricingRule {
  type?: 'auto' | 'manual' | 'percentage' | 'fixed' | string | null;
  percentageAdjustment?: number | null;
  useRounding?: boolean | null;
  roundingRule?: RoundingRule | string | null;
  conversionFee?: number | null;
}

export interface MarketLike {
  countries?: string[] | null;
  isActive?: boolean | null;
  isPrimary?: boolean | null;
  isDelete?: boolean | null;
}

export interface RateSnapshot {
  currency: string;
  ratePerUSD: number;
}

const ROUNDING_RULES: RoundingRule[] = ['0.95', '0.99', '1.00', 'nearest'];

/** Normalises a client-supplied country to an ISO-3166 alpha-2 code, or null. */
export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Normalises a client-supplied language to a short lowercase locale ('en', 'ur', 'pt-br'), or null. */
export function normalizeLocale(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(code) ? code : null;
}

/**
 * The market a buyer from `country` shops in: the first ACTIVE market that lists the country,
 * otherwise the primary (domestic) market, otherwise none. The storefront resolves it the same way.
 */
export function pickMarketForCountry<T extends MarketLike>(markets: T[], country: string | null | undefined): T | null {
  const live = markets.filter((m) => m.isActive !== false && !m.isDelete);
  const code = normalizeCountryCode(country);
  if (code) {
    const hit = live.find((m) => (m.countries ?? []).some((c) => String(c).toUpperCase() === code));
    if (hit) return hit;
  }
  return live.find((m) => m.isPrimary) ?? null;
}

/** True when the rule would change a plain FX-converted price (so a no-op rule never touches a checkout). */
export function marketRuleChangesPrice(rule: MarketPricingRule | null | undefined): boolean {
  if (!rule) return false;
  if (rule.type === 'percentage' && rule.percentageAdjustment) return true;
  if (rule.conversionFee) return true;
  return !!rule.useRounding;
}

/**
 * Applies a market's pricing rule to an amount that is ALREADY in the market currency:
 * percentage adjustment, conversion fee, then rounding. The result is never rounded when the
 * rule changes nothing beyond FX — callers do their normal per-currency rounding.
 */
export function applyMarketRule(amount: number, currency: string, rule: MarketPricingRule | null | undefined): number {
  let price = amount;
  if (!rule) return price;
  if (rule.type === 'percentage' && rule.percentageAdjustment) {
    price = price * (1 + rule.percentageAdjustment / 100);
  }
  if (rule.conversionFee) {
    price = applyConversionFee(price, rule.conversionFee);
  }
  if (rule.useRounding) {
    const wanted = String(rule.roundingRule ?? 'nearest') as RoundingRule;
    price = applyRounding(price, currency, ROUNDING_RULES.includes(wanted) ? wanted : 'nearest');
  } else if (price !== amount) {
    const factor = Math.pow(10, getCurrencyDecimals(currency));
    price = Math.round(price * factor) / factor;
  }
  return price;
}

function rateFor(currency: string, snapshots: RateSnapshot[]): number {
  if (currency === 'USD') return 1;
  const snap = snapshots.find((s) => s.currency === currency);
  if (!snap || !(snap.ratePerUSD > 0)) throw new Error(`No exchange rate snapshot for ${currency}`);
  return snap.ratePerUSD;
}

/** Same pivot maths as ExchangeRateService.convertWithSnapshots (USD pivot, ratePerUSD = units per 1 USD) but WITHOUT rounding. */
export function convertUnrounded(amount: number, from: string, to: string, snapshots: RateSnapshot[]): number {
  if (from === to) return amount;
  return (amount / rateFor(from, snapshots)) * rateFor(to, snapshots);
}

/**
 * The line's price in the SELLING store's own currency such that, once the checkout converts it to the market
 * currency, the buyer sees exactly the market's final price. Items keep their native currency — only the number moves.
 * Returned with 6 decimals (not 2) so converting back lands on the rounded market price instead of drifting by a cent.
 */
export function marketAdjustedNativeAmount(
  nativeAmount: number,
  nativeCurrency: string,
  marketCurrency: string,
  rule: MarketPricingRule | null | undefined,
  snapshots: RateSnapshot[],
): number {
  const inMarket = convertUnrounded(nativeAmount, nativeCurrency, marketCurrency, snapshots);
  const adjusted = applyMarketRule(inMarket, marketCurrency, rule);
  const back = convertUnrounded(adjusted, marketCurrency, nativeCurrency, snapshots);
  return Math.round(back * 1e6) / 1e6;
}
