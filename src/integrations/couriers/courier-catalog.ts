/* eslint-disable prettier/prettier */
import { CourierKey, COURIER_KEYS, isCourierKey } from './courier.types';

/**
 * What the seller pastes to connect each courier + the global enablement gate. Pure data, no imports of providers.
 * Credential field names here MUST match what that courier's mapping file reads (authHeaders/authBody/...).
 * Fields for couriers whose docs we do not have are UNVERIFIED guesses of the common shape — see
 * docs/courier-open-questions.md; they only matter once the owner enables that courier after sandbox testing.
 */
export interface CourierCredentialField {
  key: string;
  label: string;
  secret: boolean;
  placeholder?: string;
  optional?: boolean;
}

export interface CourierCatalogEntry {
  key: CourierKey;
  label: string;
  fields: CourierCredentialField[];
  docsUrl?: string;
}

const pw = (key = 'password', label = 'Password'): CourierCredentialField => ({ key, label, secret: true });

export const COURIER_CATALOG: Record<CourierKey, CourierCatalogEntry> = {
  postex: { key: 'postex', label: 'PostEx', fields: [{ key: 'apiToken', label: 'API token', secret: true }], docsUrl: 'https://api.postex.pk' },
  leopards: {
    key: 'leopards', label: 'Leopards Courier',
    fields: [{ key: 'apiKey', label: 'API key', secret: true }, { key: 'apiPassword', label: 'API password', secret: true }],
  },
  tcs: {
    key: 'tcs', label: 'TCS',
    fields: [{ key: 'username', label: 'Username', secret: false }, pw(), { key: 'costCenterCode', label: 'Cost center code', secret: false }],
  },
  trax: { key: 'trax', label: 'Trax', fields: [{ key: 'apiKey', label: 'API key', secret: true }] },
  mnp: { key: 'mnp', label: 'M&P (Muller & Phipps)', fields: [{ key: 'username', label: 'Username', secret: false }, pw()] },
  blueex: {
    key: 'blueex', label: 'BlueEx',
    fields: [{ key: 'username', label: 'Username', secret: false }, pw(), { key: 'accountNumber', label: 'Account number', secret: false }],
  },
  callcourier: { key: 'callcourier', label: 'CallCourier', fields: [{ key: 'username', label: 'Login ID', secret: false }, pw()] },
  swyft: { key: 'swyft', label: 'Swyft Logistics', fields: [{ key: 'apiKey', label: 'API key', secret: true }] },
  daewoo_fastex: { key: 'daewoo_fastex', label: 'Daewoo FastEx', fields: [{ key: 'username', label: 'Username', secret: false }, pw()] },
};

export function courierCatalogEntry(key: string): CourierCatalogEntry | null {
  return isCourierKey(key) ? COURIER_CATALOG[key] : null;
}

/**
 * Enablement gate. A courier is visible/bookable only if listed in COURIER_ENABLED_PROVIDERS (comma-separated, e.g.
 * "postex,leopards") AND the seller connected valid credentials. Default (unset/empty) = none enabled.
 * Read on every call so flipping the env var + restarting is the only step; unknown names are ignored.
 */
export function enabledCourierProviders(): CourierKey[] {
  const raw = process.env.COURIER_ENABLED_PROVIDERS ?? '';
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return COURIER_KEYS.filter((k) => wanted.includes(k));
}

export function isCourierEnabled(key: string): boolean {
  return isCourierKey(key) && enabledCourierProviders().includes(key);
}
