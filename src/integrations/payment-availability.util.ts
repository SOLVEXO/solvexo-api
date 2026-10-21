/* eslint-disable prettier/prettier */
import { StoreIntegrationProvider } from './schemas/store-integration.schema';

/**
 * Shopify-style availability: which payment providers a store may use is decided by the store's COUNTRY
 * (Shopify reads the store address), not by its pricing currency.
 *
 * - Pakistani gateways (Safepay, PayFast, JazzCash, Easypaisa) and bank transfer details are Pakistan-only.
 * - Stripe card payments settle straight into the seller's OWN Stripe Connect account (the platform never holds the
 *   money). Stripe only allows that for connected accounts in the platform's own country, so the allowed countries are
 *   an explicit list: env `STRIPE_CONNECT_COUNTRIES` (comma separated ISO codes, default `US`). Extend it only after
 *   confirming the country with Stripe (docs.stripe.com/connect/cross-border-payouts).
 */
const PAKISTAN_ONLY: StoreIntegrationProvider[] = ['safepay', 'payfast', 'jazzcash', 'easypaisa', 'bank_transfer'];

const PROVIDER_LABEL: Partial<Record<StoreIntegrationProvider, string>> = {
  safepay: 'Safepay', payfast: 'PayFast', jazzcash: 'JazzCash', easypaisa: 'Easypaisa', bank_transfer: 'Bank transfer', stripe: 'Stripe',
};

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

export function paymentAvailability(provider: StoreIntegrationProvider, country: string | null): PaymentAvailability {
  const label = PROVIDER_LABEL[provider] ?? provider;
  const setCountry = 'Set your store country in Settings to see the payment options available to you.';

  if (PAKISTAN_ONLY.includes(provider)) {
    if (country === 'PK') return { available: true, reason: null };
    if (!country) return { available: false, reason: setCountry };
    return { available: false, reason: `${label} is only available for stores in Pakistan.` };
  }

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

  return { available: true, reason: null };
}
