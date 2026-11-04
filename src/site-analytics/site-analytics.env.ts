/* eslint-disable prettier/prettier */
import { readFileSync } from 'fs';
import { normalizeGa4Property } from '../seo/services/seo-integrations.service';
import { MEASUREMENT_ID_RE } from './site-analytics.util';

/**
 * Google Analytics settings from the server's environment (VPS .env), as an alternative to the admin
 * Settings box (measurement id) and the SEO page's Google sign-in (reports). Several common variable names
 * are accepted so an existing setup works without renaming.
 */
export const ENV_NAMES = {
  measurementId: ['GA_MEASUREMENT_ID', 'GA4_MEASUREMENT_ID', 'GOOGLE_ANALYTICS_ID', 'GOOGLE_ANALYTICS_MEASUREMENT_ID', 'GA_ID', 'GA4_ID', 'VITE_GA_MEASUREMENT_ID'],
  propertyId: ['GA4_PROPERTY_ID', 'GA_PROPERTY_ID', 'GOOGLE_ANALYTICS_PROPERTY_ID', 'ANALYTICS_PROPERTY_ID'],
  serviceAccount: [
    'GA4_SERVICE_ACCOUNT_JSON', 'GA_SERVICE_ACCOUNT_JSON', 'GOOGLE_ANALYTICS_SERVICE_ACCOUNT', 'GOOGLE_ANALYTICS_CREDENTIALS',
    'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS_JSON',
    'GOOGLE_CREDENTIALS', 'GA_CREDENTIALS',
  ],
  credentialsFile: ['GOOGLE_APPLICATION_CREDENTIALS'],
};

export interface ServiceAccountKey { client_email: string; private_key: string; project_id?: string }
export interface GaEnv {
  measurementId: { value: string; variable: string } | null;
  propertyId: { value: string; variable: string } | null;
  serviceAccount: { key: ServiceAccountKey; variable: string } | null;
  /** Variables that are set but could not be used, with the reason (never the value). */
  problems: string[];
}

const first = (env: Record<string, string | undefined>, names: string[]) => {
  for (const n of names) {
    const v = env[n]?.trim();
    if (v) return { name: n, value: v };
  }
  return null;
};

const unquote = (v: string) => (/^(['"]).*\1$/s.test(v) ? v.slice(1, -1) : v);

/** A service account key given as JSON, base64-encoded JSON, or (GOOGLE_APPLICATION_CREDENTIALS) a file path. */
export function parseServiceAccount(raw: string, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): ServiceAccountKey | string {
  let text = unquote(raw.trim());
  if (!text.startsWith('{')) {
    if (/^[A-Za-z0-9+/=_-]+$/.test(text) && text.length > 100) {
      try { text = Buffer.from(text, 'base64').toString('utf8'); } catch { /* not base64 */ }
    } else if (/\.json$/i.test(text)) {
      try { text = readFile(text); } catch { return `file ${text} could not be read`; }
    }
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return 'is not valid JSON (paste the whole key file, or base64 of it)'; }
  if (parsed?.type && parsed.type !== 'service_account') return `is a "${parsed.type}" key, not a service account key`;
  if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string') return 'is missing client_email or private_key';
  // Keys pasted into one-line .env values often carry literal "\n" instead of line breaks.
  return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, '\n'), project_id: parsed.project_id };
}

export function readGaEnv(env: Record<string, string | undefined> = process.env, readFile?: (p: string) => string): GaEnv {
  const problems: string[] = [];
  let measurementId: GaEnv['measurementId'] = null;
  let propertyId: GaEnv['propertyId'] = null;

  const m = first(env, ENV_NAMES.measurementId);
  if (m) {
    const v = unquote(m.value).toUpperCase();
    if (MEASUREMENT_ID_RE.test(v)) measurementId = { value: v, variable: m.name };
    else if (normalizeGa4Property(v)) propertyId = { value: normalizeGa4Property(v)!, variable: m.name }; // a property id in the wrong variable
    else problems.push(`${m.name} should look like G-XXXXXXXXXX`);
  }

  const p = first(env, ENV_NAMES.propertyId);
  if (p) {
    const v = normalizeGa4Property(unquote(p.value));
    if (v) propertyId = { value: v, variable: p.name };
    else if (MEASUREMENT_ID_RE.test(unquote(p.value).toUpperCase())) {
      if (!measurementId) measurementId = { value: unquote(p.value).toUpperCase(), variable: p.name };
      problems.push(`${p.name} holds a measurement ID (G-…); the property ID is a number like 123456789 (Admin → Property settings)`);
    } else problems.push(`${p.name} should be a GA4 property ID, a number like 123456789`);
  }

  let serviceAccount: GaEnv['serviceAccount'] = null;
  const s = first(env, ENV_NAMES.serviceAccount) ?? first(env, ENV_NAMES.credentialsFile);
  if (s) {
    const parsed = parseServiceAccount(s.value, readFile);
    if (typeof parsed === 'string') problems.push(`${s.name} ${parsed}`);
    else serviceAccount = { key: parsed, variable: s.name };
  }
  return { measurementId, propertyId, serviceAccount, problems };
}
