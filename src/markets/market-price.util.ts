import { applyConversionFee, applyRounding, RoundingRule } from '@/common/rounding-rules.const';
import { getCurrencyDecimals } from '@/common/currency-metadata.const';

/** The pricing part of a Market (see schemas/market.schema.ts `pricingRule`). */
export interface MarketPricingRule {
  type?: 'auto' | 'manual' | 'percentage' | 'fixed' | string | null;
  manualRate?: number | null;
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

/** The seller's own exchange rate (1 store-currency unit = `manualRate` market units), when the rule uses one. */
export function manualRateOf(rule: MarketPricingRule | null | undefined): number | null {
  const rate = Number(rule?.manualRate);
  return rule?.type === 'manual' && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** True when the rule would change a plain FX-converted price (so a no-op rule never touches a checkout). */
export function marketRuleChangesPrice(rule: MarketPricingRule | null | undefined): boolean {
  if (!rule) return false;
  if (Number(rule.percentageAdjustment)) return true;
  if (Number(rule.conversionFee)) return true;
  if (manualRateOf(rule)) return true;
  return !!rule.useRounding;
}

/** Decimals a price is shown/charged with on this platform (PKR is whole rupees, see ExchangeRateService.roundForCurrency). */
export function displayDecimals(currency: string): number {
  return currency === 'PKR' ? 0 : getCurrencyDecimals(currency);
}

function roundToDisplay(amount: number, currency: string): number {
  const factor = Math.pow(10, displayDecimals(currency));
  return Math.round(amount * factor) / factor;
}

/**
 * Applies a market's pricing rule to ONE UNIT price that is ALREADY in the market currency:
 * percentage adjustment, conversion fee, then rounding (Shopify's order). Like Shopify, rounding only applies to
 * CONVERTED prices (`converted` false = the market sells in the store's own currency, so prices are never rounded).
 * The result is never rounded when the rule changes nothing beyond FX — callers do their normal per-currency rounding.
 */
export function applyMarketRule(
  amount: number,
  currency: string,
  rule: MarketPricingRule | null | undefined,
  converted = true,
): number {
  let price = amount;
  if (!rule) return price;
  const pct = Number(rule.percentageAdjustment);
  if (pct) price = price * (1 + pct / 100);
  const fee = Number(rule.conversionFee);
  if (fee && converted) price = applyConversionFee(price, fee);
  if (rule.useRounding && converted) {
    const wanted = String(rule.roundingRule ?? 'nearest') as RoundingRule;
    const endsInCents = wanted === '0.95' || wanted === '0.99';
    // .95/.99 only exist where prices carry cents (not JPY, KWD or whole-rupee PKR); those round to the display unit.
    if (endsInCents && displayDecimals(currency) === 2) price = applyRounding(price, currency, wanted);
    else if (wanted === '1.00') price = Math.round(price);
    else price = roundToDisplay(price, currency);
  } else if (price !== amount) {
    price = roundToDisplay(price, currency);
  }
  return price;
}

/**
 * The buyer's price for ONE unit in the market currency (what the storefront shows and checkout charges):
 *  - a fixed market price for the product/variant wins as-is (Shopify catalogs: fixed prices are not adjusted or rounded);
 *  - otherwise the store price converted at the seller's manual rate (if set) or the live rate, then the market rule.
 * `nativeCurrency` is the selling store's currency (variant prices are stored in it).
 */
export function marketUnitPrice(
  nativeUnit: number,
  nativeCurrency: string,
  marketCurrency: string,
  rule: MarketPricingRule | null | undefined,
  snapshots: RateSnapshot[],
  fixedPrice?: number | null,
): number {
  if (fixedPrice != null && Number.isFinite(Number(fixedPrice)) && Number(fixedPrice) >= 0) {
    return roundToDisplay(Number(fixedPrice), marketCurrency);
  }
  const converted = nativeCurrency !== marketCurrency;
  const manual = converted ? manualRateOf(rule) : null;
  const inMarket = manual ? nativeUnit * manual : convertUnrounded(nativeUnit, nativeCurrency, marketCurrency, snapshots);
  const adjusted = applyMarketRule(inMarket, marketCurrency, rule, converted);
  // A manual rate is a real price change even when no other rule applies: show it at display precision.
  return manual && adjusted === inMarket ? roundToDisplay(adjusted, marketCurrency) : adjusted;
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
  fixedPrice?: number | null,
): number {
  const adjusted = marketUnitPrice(nativeAmount, nativeCurrency, marketCurrency, rule, snapshots, fixedPrice);
  const back = convertUnrounded(adjusted, marketCurrency, nativeCurrency, snapshots);
  return Math.round(back * 1e6) / 1e6;
}
