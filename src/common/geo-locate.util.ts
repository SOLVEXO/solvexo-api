import geoip from 'geoip-lite';

/**
 * Resolves a real ISO-3166 country code from a request IP — offline lookup
 * (bundled MaxMind GeoLite2-derived data, no external network call at
 * request time), same `req.ip` convention this codebase already uses
 * elsewhere for audit logging (see admin-finance.controller.ts etc.).
 * Returns null for a private/loopback/unrecognized IP (e.g. local dev) —
 * callers must treat that as "no suggestion available," never a country.
 */
export function resolveCountryFromIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // A request proxied through IPv4-mapped IPv6 (`::ffff:1.2.3.4`) resolves
  // fine through geoip-lite as-is; strip only the exact prefix, don't
  // otherwise mangle a real IPv6 address.
  const cleaned = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const result = geoip.lookup(cleaned);
  return result?.country ?? null;
}
