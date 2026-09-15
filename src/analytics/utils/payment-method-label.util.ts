/* eslint-disable prettier/prettier */

/**
 * Centralized human-readable labels for `Order.paymentType` (see the enum on
 * the `Order` schema — `cash_on_delivery` | `stripe` | `manual_bank_transfer`
 * | `safepay` | `jazzcash` | `easypaisa` | `payfast`).
 *
 * Both the seller-scoped (`AnalyticsService.getPaymentMethods`) and
 * platform-wide (`AdminAnalyticsService.getPaymentBreakdown`) payment
 * breakdowns used to keep their own inline `{ cash_on_delivery, stripe }`
 * map, so every method added after those two (manual_bank_transfer,
 * safepay, jazzcash, easypaisa, payfast) fell through to `r._id ?? r._id`
 * and rendered as the raw enum value in the UI. One shared map, kept next
 * to the enum it mirrors — add a new payment method here when the Order
 * schema's `paymentType` enum grows.
 */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash_on_delivery: 'Cash on Delivery',
  stripe: 'Card (Stripe)',
  manual_bank_transfer: 'Manual Bank Transfer',
  safepay: 'Safepay',
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  payfast: 'PayFast',
};

/** Falls back to the raw enum value for a payment method added to the schema but not yet mapped above, rather than throwing. */
export function getPaymentMethodLabel(paymentType: string | null | undefined): string {
  if (!paymentType) return 'Unknown';
  return PAYMENT_METHOD_LABELS[paymentType] ?? paymentType;
}
