/* eslint-disable prettier/prettier */
import { PAYMENT_PROVIDER_CATALOG, catalogEntry } from './payment-provider-catalog';

/**
 * Shopify-style availability: which payment providers a store may use is decided by the store's COUNTRY
 * (Shopify reads the store address), not by its pricing currency. The facts per provider live in
 * `payment-provider-catalog.ts`; this file only applies them.
 *
 * - Stripe Connect ("stripe") is the platform's own card rail: card money settles straight into the seller's OWN
 *   Stripe Connect account and the platform never holds it. Stripe only allows that for connected accounts in the
 *   platform's own country, so the allowed countries are an explicit list: env `STRIPE_CONNECT_COUNTRIES`
 *   (comma separated ISO codes, default `US`). Extend it only after confirming the country with Stripe
 *   (docs.stripe.com/connect/cross-border-payouts).
 * - Every other provider is a third-party gateway the seller connects with their own keys (plan transaction fee
 *   applies); where it is offered follows the provider's own coverage in the catalog.
 */
export interface PaymentAvailability {
  available: boolean;
  /** Plain-language reason shown to the seller when `available` is false. */
  reason: string | null;
}

export function stripeConnectCountries(): string[] {
  const raw = process.env.STRIPE_CONNECT_COUNTRIES ?? 'US';
  return raw.split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
}

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * The country payment availability is judged on. Stores created before the country was collected have none stored:
 * their pricing currency is the only hint (PKR = Pakistan, USD = United States); anything else stays unknown.
 */
export function resolveStoreCountry(store: { country?: string | null; baseCurrency?: string | null }): string | null {
  const stored = String(store.country ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(stored)) return stored;
  if (store.baseCurrency === 'PKR') return 'PK';
  if (store.baseCurrency === 'USD') return 'US';
  return null;
}

export function paymentAvailability(provider: string, country: string | null): PaymentAvailability {
  const entry = catalogEntry(provider);
  const label = entry?.label ?? provider;
  const setCountry = 'Set your store country in Settings to see the payment options available to you.';

  if (provider === 'stripe') {
    if (!country) return { available: false, reason: setCountry };
    if (stripeConnectCountries().includes(country)) return { available: true, reason: null };
    if (country === 'PK') {
      return { available: false, reason: 'Stripe does not support businesses in Pakistan. Use Safepay, PayFast, Cash on Delivery or bank transfer instead.' };
    }
    return {
      available: false,
      reason: `Card payments through Stripe are not available for stores in ${countryName(country)} yet. Use Cash on Delivery or bank transfer instead.`,
    };
  }

  if (!entry) return { available: true, reason: null };
  if (!country) return { available: false, reason: setCountry };
  // Stripe Standard is only for countries where the platform's own destination-charge Connect (the "stripe" option) is not offered.
  if (provider === 'stripe_standard' && stripeConnectCountries().includes(country)) {
    return { available: false, reason: 'Stripe is already available for your country through the main card payment option.' };
  }
  if (entry.excludedCountries?.includes(country)) {
    return { available: false, reason: `${label} is not available for stores in ${countryName(country)}.` };
  }
  if (entry.countries === '*' || entry.countries.includes(country)) return { available: true, reason: null };
  if (entry.countries.length === 1 && entry.countries[0] === 'PK') {
    return { available: false, reason: `${label} is only available for stores in Pakistan.` };
  }
  return { available: false, reason: `${label} is not available for stores in ${countryName(country)}.` };
}

/** Third-party gateways (everything except Stripe Connect and bank transfer) a store in `country` can connect, in catalog order. */
export function gatewayKeysForCountry(country: string | null): string[] {
  return Object.values(PAYMENT_PROVIDER_CATALOG)
    .filter((e) => e.key !== 'stripe' && e.key !== 'bank_transfer' && paymentAvailability(e.key, country).available)
    .map((e) => e.key);
}
