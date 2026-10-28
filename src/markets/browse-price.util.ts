import {
  displayDecimals,
  marketUnitPrice,
  type MarketPricingRule,
  type RateSnapshot,
} from './market-price.util';
import { fixedPriceFor, type FixedMarketPrice } from './market-pricing.service';

/**
 * Everything needed to turn a catalogue (store currency) price into the price a buyer SEES in the storefront.
 * Mirrors the storefront's `convertAmount` / `computeMarketPrice` (`solvexo-web/src/utils/marketPriceMath.ts`):
 * the market's rule and fixed prices only apply when the buyer's currency is the market's own currency.
 */
export interface BrowsePriceContext {
  /** The selling store's currency (variant prices are stored in it). */
  nativeCurrency: string;
  /** The currency the buyer sees (and types price filters in). */
  buyerCurrency: string;
  /** The buyer's market, when there is one. */
  market: { currency: string; pricingRule: MarketPricingRule | null | undefined } | null;
  /** Fixed catalogue prices of that market. */
  fixed: Map<string, FixedMarketPrice>;
  snapshots: RateSnapshot[];
}

/** Shown price of one catalogue unit (product + its cheapest variant) in the buyer's currency. */
export function browseDisplayPrice(
  nativeUnit: number,
  productId: string,
  variantId: string | null | undefined,
  ctx: BrowsePriceContext,
): number {
  const { nativeCurrency: from, buyerCurrency: to } = ctx;
  const ruleApplies = !!ctx.market && ctx.market.currency === to;
  const fixed = ruleApplies ? fixedPriceFor(ctx.fixed, productId, variantId) : null;
  const rule = ruleApplies ? ctx.market!.pricingRule : null;
  // Same currency and nothing in the market that moves the price: the catalogue price is shown untouched.
  if (from === to && !(ruleApplies && (Number(rule?.percentageAdjustment) || fixed))) return nativeUnit;
  const price = marketUnitPrice(nativeUnit, from, to, rule, ctx.snapshots, fixed?.fixedPrice ?? null);
  const factor = Math.pow(10, displayDecimals(to));
  return Math.round(price * factor) / factor;
}

/** Compare a shown price with a typed bound: prices carry at most 3 decimals, so the edges are inclusive. */
export function priceInRange(price: number, min: number | null, max: number | null): boolean {
  const eps = 1e-6;
  if (min !== null && price < min - eps) return false;
  if (max !== null && price > max + eps) return false;
  return true;
}
