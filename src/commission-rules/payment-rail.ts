/**
 * Shopify-style fee model: WHICH payment rail a sale used decides whether the plan's
 * transaction fee applies.
 *
 *  - `solvexo_card`  — the buyer paid by card through Solvexo's own Stripe (Solvexo
 *    Payments, Shopify's "Shopify Payments"): NO Solvexo commission, only the card
 *    processing cost, passed through.
 *  - `manual`        — cash on delivery / bank transfer / in-person: the buyer paid the
 *    seller directly, Solvexo processed nothing — no transaction fee (Shopify: "manual
 *    payment methods" are fee-free).
 *  - `third_party`   — any other gateway the seller connected (SafePay, JazzCash,
 *    Easypaisa, PayFast, PayPal…): the plan's third-party transaction fee applies
 *    (Shopify's "third-party transaction fee": lower on bigger plans).
 *
 * An admin-negotiated per-seller commission (`seller_override`) is a deliberate custom
 * deal, so it still applies to every rail.
 */
export type PaymentRail = 'solvexo_card' | 'manual' | 'third_party';

const SOLVEXO_CARD_METHODS = new Set(['stripe', 'credit_card', 'debit_card']);
const MANUAL_METHODS = new Set(['cash_on_delivery', 'cod', 'manual_bank_transfer', 'bank_transfer', 'cash', 'pos', 'manual', 'store_credit']);

export function classifyPaymentRail(paymentMethodType?: string | null): PaymentRail {
  const m = (paymentMethodType ?? 'stripe').toLowerCase();
  if (SOLVEXO_CARD_METHODS.has(m)) return 'solvexo_card';
  if (MANUAL_METHODS.has(m)) return 'manual';
  return 'third_party'; // unknown/new gateways are treated as third-party, never silently fee-free
}

export interface RailRate<S extends string = string> { rate: number; source: S | 'payment_method_exempt' }

/** The commission actually charged on a sale, given the store's resolved rate and the rail it used. */
export function rateForPaymentRail<S extends string>(
  resolved: { rate: number; source: S },
  paymentMethodType?: string | null,
): RailRate<S> {
  if (resolved.source === 'seller_override') return resolved;
  if (classifyPaymentRail(paymentMethodType) !== 'third_party') return { rate: 0, source: 'payment_method_exempt' };
  return resolved;
}
