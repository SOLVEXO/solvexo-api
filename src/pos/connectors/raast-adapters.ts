/* eslint-disable prettier/prettier */
/**
 * G5.4 — the REAL Raast providers are typed TODOs. The payments layer (payments-core) already talks to providers through `PaymentProvider`; the mock is
 * registered outside production. A real adapter is added to `buildProviders` once its contract tests pass. Until then it throws "not configured".
 * Nothing below guesses a provider's fields, endpoints or certification steps — each entry lists exactly what is needed.
 */
export const RAAST_PROVIDER_NEEDS: Record<string, string[]> = {
  payfast: [
    'PayFast (Pakistan) merchant agreement for Raast QR (dynamic QR, P2M) — from Sir Atiq',
    'API documentation: create dynamic QR, payment status, refund, webhook / IPN signature scheme',
    'Sandbox merchant ID + secured key, and the production credentials',
    'Sub-merchant (per store) onboarding steps and the reference to store in KYB (subMerchant.ref)',
    'Settlement report format (for reconciliation)',
  ],
  '1link': [
    '1LINK Raast P2M participation route (directly or through a sponsor bank) — from Sir Atiq',
    'The 1LINK / sponsor-bank API specification for dynamic QR, status inquiry, refund (RTP / return), callback signature',
    'Sandbox (UAT) credentials, certificates (mTLS if required), IP whitelisting',
    'Certification / go-live checklist from 1LINK',
    'Merchant / sub-merchant IDs per store and how they map to KYB',
  ],
};
export class RaastProviderNotConfiguredError extends Error {
  constructor(readonly key: string) { super(`Raast provider "${key}" is not configured: ${(RAAST_PROVIDER_NEEDS[key] ?? []).join('; ')}`); }
}
/** Placeholder factory used by docs/tests: always throws until the adapter is written. */
export function notConfiguredRaastProvider(key: 'payfast' | '1link'): never { throw new RaastProviderNotConfiguredError(key); }
