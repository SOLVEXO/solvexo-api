/* eslint-disable prettier/prettier */
/**
 * ONE place that describes every payment provider a store can connect: where it works (store country), which
 * currencies it can charge, what the seller has to paste in, how its webhook is set up, and whether refunds are
 * automatic. Pure data (no imports) so schemas, services and the seller UI all read the same facts.
 *
 * Shopify parity: the provider list a seller sees depends on the store's country; every gateway other than the
 * platform's own card rail ("Solvexo Payments" = Stripe Connect) is a third-party gateway with the plan's
 * third-party transaction fee.
 *
 * API details of the providers added with `generic: true` come from each provider's public documentation and were
 * NEVER run against a live/sandbox account — test each one with real sandbox credentials before enabling it.
 */
export type GatewayWebhookSetup =
  /** Nothing to register: the result is read back from the gateway's own API (Mollie) or the callback is signed with the API key (Paystack). */
  | 'none'
  /** The seller registers our webhook URL in the gateway's dashboard and pastes back the signing secret / webhook id. */
  | 'secret'
  /** The seller registers our webhook URL; the gateway signs nothing we need to store. */
  | 'url';

export interface GatewayCredentialField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  help?: string;
  /** Not required to connect (rare). */
  optional?: boolean;
}

export interface GatewayCatalogEntry {
  key: string;
  label: string;
  /** Store countries the provider can be offered in ('*' = anywhere except `excludedCountries`). */
  countries: '*' | string[];
  excludedCountries?: string[];
  /** Currencies the provider can charge ('*' = any). The charge currency is the store currency when listed, else the first. */
  currencies: '*' | string[];
  /** Fields the seller pastes when connecting (only for `generic` providers; the older Pakistani gateways have their own form). */
  fields: GatewayCredentialField[];
  /** True = connected through the shared, catalog-driven connect form and `PaymentProvider` contract. */
  generic: boolean;
  webhook: GatewayWebhookSetup;
  /** Label of the value the seller pastes after registering the webhook (stored as `webhookSecret`). */
  webhookSecretLabel?: string;
  /** Short instruction shown next to the webhook URL. */
  webhookHelp?: string;
  /** `api` = the provider's refund API is called automatically; `manual` = the seller refunds in the gateway's own portal. */
  refunds: 'api' | 'manual';
  /** Collects the buyer's wallet number at checkout (Easypaisa). */
  walletAccount?: boolean;
  /** Mode is taken from the key itself when it carries one (sk_test_..., rzp_live_...); else the seller picks. */
  modeFromKey?: Array<{ field: string; sandboxPrefix: string[]; livePrefix: string[] }>;
  docsUrl?: string;
}

const PK = ['PK'];
// Stripe: countries where a business can open a Stripe account (stripe.com/global, checked 2026-10-26), without the
// "Preview" (IN, ID) and "Extended network" (CI, GH, KE, NG, ZA — served through Paystack) entries.
const STRIPE_ACCOUNT_COUNTRIES = [
  'AU', 'AT', 'BE', 'BR', 'BG', 'CA', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GI', 'GR', 'HK', 'HU', 'IE', 'IT',
  'JP', 'LV', 'LI', 'LT', 'LU', 'MY', 'MT', 'MX', 'NL', 'NZ', 'NO', 'PL', 'PT', 'RO', 'SG', 'SK', 'SI', 'ES', 'SE', 'CH',
  'TH', 'AE', 'GB', 'US',
];
const EUROPE_MOLLIE = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'NO', 'IS', 'LI', 'GB', 'CH',
];

export const PAYMENT_PROVIDER_CATALOG: Record<string, GatewayCatalogEntry> = {
  // ── Pakistan (own connect forms, see StoreIntegrationsService.connectPayment) ──
  safepay: { key: 'safepay', label: 'Safepay', countries: PK, currencies: ['PKR'], fields: [], generic: false, webhook: 'secret', webhookSecretLabel: 'Webhook secret', refunds: 'api' },
  payfast: { key: 'payfast', label: 'PayFast', countries: PK, currencies: ['PKR'], fields: [], generic: false, webhook: 'url', refunds: 'manual' },
  jazzcash: { key: 'jazzcash', label: 'JazzCash', countries: PK, currencies: ['PKR'], fields: [], generic: false, webhook: 'url', refunds: 'manual' },
  easypaisa: { key: 'easypaisa', label: 'Easypaisa', countries: PK, currencies: ['PKR'], fields: [], generic: false, webhook: 'none', refunds: 'manual', walletAccount: true },
  bank_transfer: { key: 'bank_transfer', label: 'Bank transfer', countries: PK, currencies: '*', fields: [], generic: false, webhook: 'none', refunds: 'manual' },

  // ── Stripe Connect (the platform's own card rail; availability = STRIPE_CONNECT_COUNTRIES, see payment-availability.util.ts) ──
  stripe: { key: 'stripe', label: 'Stripe', countries: '*', currencies: '*', fields: [], generic: false, webhook: 'none', refunds: 'api' },

  // ── Stripe Connect STANDARD account + DIRECT charges: the zero-fee global card rail (any Stripe country where the
  //    platform's destination-charge Connect is not available). The seller owns the Stripe account and Stripe bills the
  //    seller directly, so the platform takes no application fee and never touches the money. Own connect flow.
  stripe_standard: {
    key: 'stripe_standard', label: 'Stripe', countries: STRIPE_ACCOUNT_COUNTRIES, currencies: '*', fields: [], generic: false,
    webhook: 'none', refunds: 'api', docsUrl: 'https://docs.stripe.com/connect/standard-accounts',
  },

  // ── Global gateways with the seller's OWN keys (third-party gateway rail) ──
  stripe_own: {
    key: 'stripe_own', label: 'Stripe (your own account)', countries: STRIPE_ACCOUNT_COUNTRIES, currencies: '*', generic: true,
    fields: [{ key: 'secretKey', label: 'Secret key', secret: true, placeholder: 'sk_live_… or rk_live_…', help: 'Stripe Dashboard → Developers → API keys. A restricted key needs write access to Checkout Sessions and Refunds.' }],
    webhook: 'secret', webhookSecretLabel: 'Webhook signing secret', webhookHelp: 'Stripe Dashboard → Developers → Webhooks → add the URL below and select checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed and checkout.session.expired. Then paste the signing secret (whsec_…).',
    refunds: 'api', modeFromKey: [{ field: 'secretKey', sandboxPrefix: ['sk_test_', 'rk_test_'], livePrefix: ['sk_live_', 'rk_live_'] }],
    docsUrl: 'https://docs.stripe.com/payments/checkout',
  },
  paypal: {
    key: 'paypal', label: 'PayPal', countries: '*', excludedCountries: ['PK', 'AF', 'CU', 'IR', 'KP', 'SY'],
    currencies: ['AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD'],
    generic: true,
    fields: [
      { key: 'clientId', label: 'Client ID', secret: false, help: 'developer.paypal.com → Apps & Credentials → your REST app.' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    webhook: 'secret', webhookSecretLabel: 'Webhook ID', webhookHelp: 'developer.paypal.com → your app → Webhooks → add the URL below with the events PAYMENT.CAPTURE.COMPLETED, PAYMENT.CAPTURE.DENIED and CHECKOUT.ORDER.APPROVED, then paste the Webhook ID.',
    refunds: 'api', docsUrl: 'https://developer.paypal.com/docs/api/orders/v2/',
  },
  razorpay: {
    key: 'razorpay', label: 'Razorpay', countries: ['IN'], currencies: ['INR'], generic: true,
    fields: [
      { key: 'keyId', label: 'Key ID', secret: false, placeholder: 'rzp_live_…' },
      { key: 'keySecret', label: 'Key secret', secret: true },
    ],
    webhook: 'secret', webhookSecretLabel: 'Webhook secret', webhookHelp: 'Razorpay Dashboard → Account & Settings → Webhooks → add the URL below with the payment_link.paid, payment_link.cancelled and payment_link.expired events and choose a secret, then paste that secret.',
    refunds: 'api', modeFromKey: [{ field: 'keyId', sandboxPrefix: ['rzp_test_'], livePrefix: ['rzp_live_'] }],
    docsUrl: 'https://razorpay.com/docs/payments/payment-links/',
  },
  paystack: {
    key: 'paystack', label: 'Paystack', countries: ['NG', 'GH', 'ZA', 'KE', 'CI', 'EG', 'RW'], currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'XOF', 'EGP', 'RWF', 'USD'], generic: true,
    fields: [{ key: 'secretKey', label: 'Secret key', secret: true, placeholder: 'sk_live_…', help: 'Paystack Dashboard → Settings → API Keys & Webhooks.' }],
    webhook: 'url', webhookHelp: 'Paystack Dashboard → Settings → API Keys & Webhooks → paste the URL below as the Live (or Test) Webhook URL. Paystack signs it with your secret key, so nothing else is needed.',
    refunds: 'api', modeFromKey: [{ field: 'secretKey', sandboxPrefix: ['sk_test_'], livePrefix: ['sk_live_'] }],
    docsUrl: 'https://paystack.com/docs/payments/accept-payments/',
  },
  flutterwave: {
    key: 'flutterwave', label: 'Flutterwave', countries: ['NG', 'GH', 'KE', 'ZA', 'UG', 'TZ', 'RW', 'ZM', 'CI', 'SN', 'CM', 'EG'],
    currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS', 'RWF', 'ZMW', 'XOF', 'XAF', 'EGP', 'USD', 'GBP', 'EUR'], generic: true,
    fields: [{ key: 'secretKey', label: 'Secret key', secret: true, placeholder: 'FLWSECK-…', help: 'Flutterwave Dashboard → Settings → API Keys (v3).' }],
    webhook: 'secret', webhookSecretLabel: 'Secret hash', webhookHelp: 'Flutterwave Dashboard → Settings → Webhooks → paste the URL below and choose a Secret hash, then paste the same hash here.',
    refunds: 'api', modeFromKey: [{ field: 'secretKey', sandboxPrefix: ['FLWSECK_TEST', 'FLWSECK-TEST'], livePrefix: ['FLWSECK-'] }],
    docsUrl: 'https://developer.flutterwave.com/docs/collecting-payments/standard',
  },
  mollie: {
    key: 'mollie', label: 'Mollie', countries: EUROPE_MOLLIE,
    currencies: ['AED', 'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'ILS', 'ISK', 'JPY', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TWD', 'USD', 'ZAR'], generic: true,
    fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'live_… or test_…', help: 'Mollie Dashboard → Developers → API keys.' }],
    webhook: 'none', refunds: 'api', modeFromKey: [{ field: 'apiKey', sandboxPrefix: ['test_'], livePrefix: ['live_'] }],
    docsUrl: 'https://docs.mollie.com/reference/create-payment',
  },
};

/** Provider keys that go through the shared gateway contract (`PaymentProvider`) and a webhook/return flow. */
export const GENERIC_GATEWAY_KEYS = Object.values(PAYMENT_PROVIDER_CATALOG).filter((e) => e.generic).map((e) => e.key);

/** Every key a PaymentTransaction/Order `paymentType` may carry besides cod/manual/store credit. */
export const GATEWAY_PAYMENT_TYPES = ['stripe', 'stripe_standard', 'safepay', 'jazzcash', 'easypaisa', 'payfast', ...GENERIC_GATEWAY_KEYS];

/** True for a seller's own third-party gateway (not Stripe Connect, not bank transfer / manual methods). */
export function isThirdPartyGatewayType(paymentType: string | null | undefined): boolean {
  const entry = paymentType ? PAYMENT_PROVIDER_CATALOG[paymentType] : undefined;
  return !!entry && entry.key !== 'stripe' && entry.key !== 'bank_transfer';
}

export function catalogEntry(provider: string): GatewayCatalogEntry | undefined {
  return PAYMENT_PROVIDER_CATALOG[provider];
}

/** Currency a gateway charges for a store: the store's own currency when the gateway takes it, else the gateway's first one. */
export function gatewayChargeCurrency(provider: string, storeCurrency: string | null | undefined): string {
  const entry = PAYMENT_PROVIDER_CATALOG[provider];
  const store = (storeCurrency || '').toUpperCase();
  if (!entry || entry.currencies === '*') return store || 'USD';
  if (store && entry.currencies.includes(store)) return store;
  return entry.currencies[0];
}

/** Sandbox/live from the key prefix when the provider encodes it; null = the seller has to say. */
export function inferGatewayMode(provider: string, credentials: Record<string, any>): 'sandbox' | 'live' | null {
  const rules = PAYMENT_PROVIDER_CATALOG[provider]?.modeFromKey ?? [];
  for (const r of rules) {
    const v = String(credentials?.[r.field] ?? '');
    if (r.sandboxPrefix.some((p) => v.startsWith(p))) return 'sandbox';
    if (r.livePrefix.some((p) => v.startsWith(p))) return 'live';
  }
  return null;
}
