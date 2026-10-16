/**
 * Stripe minor-unit conversion — the ONE place every Stripe `amount` is built
 * or read. Stripe's own rules (docs.stripe.com/currencies), which are NOT the
 * same as ISO-4217 decimals in two places:
 *  - zero-decimal currencies (JPY, KRW, VND, ...): amount = whole units (×1);
 *  - ISK and UGX: zero-decimal, but for backward compatibility Stripe wants
 *    them as a two-decimal value whose decimals are always 00 (5 ISK = 500);
 *  - three-decimal currencies (KWD, BHD, JOD, OMR, TND): ×1000, and the last
 *    digit must be 0 (Stripe rejects anything else);
 *  - everything else (USD, EUR, PKR, ...): ×100.
 * Writing and reading with the same helper keeps charge, capture, refund,
 * webhook and payment-verification amounts in the same units.
 */
const STRIPE_ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const STRIPE_WHOLE_UNITS_AS_TWO_DECIMAL = new Set(['ISK', 'UGX']);
const STRIPE_THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

function norm(currency: string | null | undefined): string {
  return String(currency || 'USD').toUpperCase();
}

/** Major units → Stripe `amount` (integer minor units) for `currency`. */
export function toStripeAmount(amount: number, currency: string | null | undefined): number {
  const cur = norm(currency);
  const value = Number(amount) || 0;
  if (STRIPE_ZERO_DECIMAL.has(cur)) return Math.round(value);
  if (STRIPE_WHOLE_UNITS_AS_TWO_DECIMAL.has(cur)) return Math.round(value) * 100;
  if (STRIPE_THREE_DECIMAL.has(cur)) return Math.round((value * 1000) / 10) * 10;
  return Math.round(value * 100);
}

/** Stripe `amount` (minor units) → major units for `currency`. */
export function fromStripeAmount(minor: number | null | undefined, currency: string | null | undefined): number {
  const cur = norm(currency);
  const value = Number(minor) || 0;
  if (STRIPE_ZERO_DECIMAL.has(cur)) return value;
  if (STRIPE_THREE_DECIMAL.has(cur)) return value / 1000;
  return value / 100; // ISK/UGX are sent ×100 too
}

/** Snap an already-computed Stripe amount (e.g. a percentage fee) to a value
 *  Stripe accepts for `currency`: whole hundreds for ISK/UGX, a trailing 0 for
 *  three-decimal currencies, a whole number otherwise. */
export function roundStripeMinor(minor: number, currency: string | null | undefined): number {
  const cur = norm(currency);
  const value = Number(minor) || 0;
  if (STRIPE_WHOLE_UNITS_AS_TWO_DECIMAL.has(cur)) return Math.round(value / 100) * 100;
  if (STRIPE_THREE_DECIMAL.has(cur)) return Math.round(value / 10) * 10;
  return Math.round(value);
}

/** How many Stripe minor units make one major unit of `currency` (1, 100 or 1000). */
export function stripeMinorUnitFactor(currency: string | null | undefined): number {
  const cur = norm(currency);
  if (STRIPE_ZERO_DECIMAL.has(cur)) return 1;
  if (STRIPE_THREE_DECIMAL.has(cur)) return 1000;
  return 100;
}
