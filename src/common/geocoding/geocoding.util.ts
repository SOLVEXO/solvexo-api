/* eslint-disable prettier/prettier */
/**
 * Server-side address geocoding for the local-delivery radius (so a seller never has to hand-enter latitude /
 * longitude). Free OpenStreetMap Nominatim, NO API key. Optional + best effort: every failure resolves to `null`
 * and callers fall back to the manual coordinates / postcode list.
 *
 * Nominatim usage policy honoured here: a descriptive User-Agent, max 1 request per second (global serial queue),
 * results cached (positive 30 days, negative 1 day, bounded LRU) and callers persist the result on the address /
 * location document so each address is geocoded once.
 *
 * Env (all optional): GEOCODING_PROVIDER=none disables it; GEOCODING_USER_AGENT overrides the UA (should contain a
 * contact); GEOCODING_BASE_URL points at a self-hosted Nominatim.
 */

export interface GeocodeInput {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  /** ISO-3166 alpha-2 (e.g. "PK") or a country name. */
  country?: string | null;
}
export interface Coords { latitude: number; longitude: number }

const POSITIVE_TTL_MS = 30 * 24 * 3600 * 1000;
const NEGATIVE_TTL_MS = 24 * 3600 * 1000;
const MAX_CACHE = 5000;
const MIN_GAP_MS = 1100; // Nominatim: absolute max 1 request / second
const TIMEOUT_MS = 4000;

const clean = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export function isGeocodingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.GEOCODING_PROVIDER ?? 'nominatim').toLowerCase() !== 'none';
}

/** Stable cache key + free-text query. Needs at least a city/postcode AND a country to be worth a lookup. */
export function buildGeocodeQuery(input: GeocodeInput | null | undefined): { key: string; query: string; countryCode: string | null } | null {
  if (!input) return null;
  const line1 = clean(input.addressLine1);
  const line2 = clean(input.addressLine2);
  const city = clean(input.city);
  const state = clean(input.state);
  const zip = clean(input.zipCode);
  const country = clean(input.country);
  if (!country || (!city && !zip)) return null;
  const parts = [line1, line2, city, state, zip].filter(Boolean);
  const countryCode = /^[A-Za-z]{2}$/.test(country) ? country.toLowerCase() : null;
  const query = countryCode ? parts.join(', ') : [...parts, country].join(', ');
  return { key: `${countryCode ?? country.toLowerCase()}|${query.toLowerCase()}`, query, countryCode };
}

/** First valid result of a Nominatim JSON array -> coordinates (null when empty / malformed / out of range). */
export function parseNominatimResponse(data: unknown): Coords | null {
  const first = Array.isArray(data) ? (data[0] as any) : null;
  if (!first) return null;
  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

const cache = new Map<string, { at: number; value: Coords | null }>();
let queueTail: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

/** Test hook. */
export function _resetGeocodingState() { cache.clear(); queueTail = Promise.resolve(); lastCallAt = 0; }

function cacheGet(key: string): { hit: boolean; value: Coords | null } {
  const e = cache.get(key);
  if (!e) return { hit: false, value: null };
  const ttl = e.value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  if (Date.now() - e.at > ttl) { cache.delete(key); return { hit: false, value: null }; }
  cache.delete(key); cache.set(key, e); // LRU touch
  return { hit: true, value: e.value };
}
function cacheSet(key: string, value: Coords | null) {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string);
}

/**
 * Geocode an address. Never throws; null = unknown / disabled / failed. `opts.fetchImpl` / `opts.sleep` exist for tests.
 */
export async function geocodeAddress(
  input: GeocodeInput | null | undefined,
  opts: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv } = {},
): Promise<Coords | null> {
  const env = opts.env ?? process.env;
  if (!isGeocodingEnabled(env)) return null;
  const q = buildGeocodeQuery(input);
  if (!q) return null;
  const cached = cacheGet(q.key);
  if (cached.hit) return cached.value;

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => (globalThis as any).fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = (env.GEOCODING_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
  const userAgent = env.GEOCODING_USER_AGENT || 'Solvexo/1.0 (local-delivery radius geocoding; contact via solvexo.store)';

  const run = async (): Promise<Coords | null> => {
    const again = cacheGet(q.key); // another queued call may have resolved the same address meanwhile
    if (again.hit) return again.value;
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const url = `${base}/search?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(q.query)}${q.countryCode ? `&countrycodes=${q.countryCode}` : ''}`;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: ctrl?.signal });
      if (!res.ok) return null; // transient (429/5xx): do not cache
      const value = parseNominatimResponse(await res.json());
      cacheSet(q.key, value);
      return value;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const result = queueTail.then(run, run);
  queueTail = result.catch(() => null);
  return result;
}
