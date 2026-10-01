/** Card-network cost on a Stripe sale (what Stripe really charges). Passed through to the
 *  seller exactly — like Shopify Payments' card rate — and never marked up. */
export const PAYMENT_PROCESSING_RATE = 0.029;  // 2.9%
export const PAYMENT_PROCESSING_FIXED = 0.30;  // $0.30 per transaction
