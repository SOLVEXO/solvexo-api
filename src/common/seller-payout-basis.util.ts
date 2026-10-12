/* eslint-disable prettier/prettier */
import { classifyPaymentRail } from '../commission-rules/payment-rail';

const round = (n: number) => Math.round(n * 100) / 100;

/** What the seller actually collected for a sellerOrder in cash terms (subtotal + platform-sponsored discount + tax), in the SELLER'S OWN currency (`settlementCurrency`). */
export function sellerCashBasis(so: any): number {
  if (so.settlementAmount != null) return so.settlementAmount;
  return round((so.subtotal ?? 0) + (so.platformSponsoredDiscountUSD ?? 0) + (so.taxAmount ?? 0));
}

/** True when the buyer's money went straight to the seller (Connect card, COD, bank transfer, the seller's own gateway) — not held by the platform. */
export function isDirectSale(so: any, order: any): boolean {
  return !!so?.settledViaConnect || classifyPaymentRail(order?.paymentType) !== 'solvexo_card';
}

/** Order-currency amount of `items` that was paid with a gift card / store credit (item prices are stored net of those shares). */
function giftCreditShareOrderCurrency(items: any[] | undefined): number {
  return (items ?? []).reduce((s, i) => s + (Number(i?.giftCardDiscountUSD) || 0) + (Number(i?.storeCreditDiscountUSD) || 0), 0);
}

/** order-currency -> settlement-currency factor, from the sellerOrder's own cash figures (exact when both use the same frozen rate). */
function settlementFactor(so: any): number {
  const gross = (so.subtotal ?? 0) + (so.platformSponsoredDiscountUSD ?? 0) + (so.taxAmount ?? 0);
  return so.settlementAmount != null && gross > 0 ? so.settlementAmount / gross : 1;
}

/** Gift-card / store-credit share of `items` (default: every item of the sellerOrder) in the seller's settlement currency. */
export function giftCreditShareSettlement(so: any, items?: any[]): number {
  const share = giftCreditShareOrderCurrency(items ?? so.items);
  return share > 0 ? round(share * settlementFactor(so)) : 0;
}

/**
 * A sellerOrder's SALE amount for the finance ledger (FinanceService.recordSale), in the seller's settlement currency.
 * Gift cards and store credit are a way of PAYING, not a discount (Shopify), so for a DIRECT sale the part paid with them is
 * part of the sale (matching Analytics). A platform-held card sale keeps the cash basis — the platform never held that share.
 */
export function sellerPayoutBasis(so: any, order?: any): number {
  const cash = sellerCashBasis(so);
  return order && isDirectSale(so, order) ? round(cash + giftCreditShareSettlement(so)) : cash;
}

/** Gift-card / store-credit part of the sale that the ledger recorded for this sellerOrder (0 for a platform-held sale). */
export function sellerGiftCreditShare(so: any, order: any): number {
  return order && isDirectSale(so, order) ? giftCreditShareSettlement(so) : 0;
}

/**
 * The part of a refund that returns to the buyer's gift card / store credit (not to the card): for a direct sale it must also come
 * out of the ledger sale, otherwise a full refund would leave that share behind as revenue. `fraction` = refunded / wanted when
 * the refund was clamped by the shared refund budget.
 */
export function refundGiftCreditShare(so: any, order: any, items: any[], fraction = 1): number {
  if (!isDirectSale(so, order)) return 0;
  return round(giftCreditShareSettlement(so, items) * Math.max(0, Math.min(1, fraction)));
}

export function sellerPayoutCurrency(so: any, order: any): string {
  return so.settlementCurrency ?? order.currency ?? 'USD';
}
