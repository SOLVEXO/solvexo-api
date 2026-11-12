/* eslint-disable prettier/prettier */
import { isIP } from 'net';

/**
 * G5.1 — `API_PUBLIC_URL` is the origin printed inside every receipt QR (`<origin>/r/s/<store>/<client key>`, built OFFLINE by the till from the
 * base the server hands it) and in e-mail links. A wrong value prints QR codes that lead nowhere and cannot be re-issued, so outside development
 * the API REFUSES TO START when it is missing, not https, or points to localhost / a private, loopback or link-local address.
 * Development and tests (`NODE_ENV` = development | test) are exempt (the dev stack runs on http://localhost).
 */
export const DEV_ENVS: ReadonlySet<string> = new Set(['development', 'test']);

const PRIVATE_V4 = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const PRIVATE_NAMES = /(^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$|\.corp$)/i;

function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (PRIVATE_NAMES.test(h)) return true;
  const v = isIP(h);
  if (v === 4) return PRIVATE_V4.some((r) => r.test(h));
  if (v === 6) {
    // IPv4-mapped (URL normalizes ::ffff:192.168.1.1 to ::ffff:c0a8:101): judge the embedded IPv4
    const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (m) { const a = parseInt(m[1], 16), b = parseInt(m[2], 16); return privateHost(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`); }
  }
  if (v === 6) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return false;
}

/** null = acceptable; otherwise the reason the API must not start. */
export function publicUrlProblem(value: string | undefined, nodeEnv: string | undefined): string | null {
  if (DEV_ENVS.has(nodeEnv ?? '')) return null;
  const raw = (value ?? '').trim();
  if (!raw) return 'API_PUBLIC_URL is not set — it is printed in every receipt QR; set it to this API\'s public https origin';
  let u: URL;
  try { u = new URL(raw); } catch { return `API_PUBLIC_URL is not a valid URL: "${raw}"`; }
  if (u.protocol !== 'https:') return `API_PUBLIC_URL must be https (got ${u.protocol.replace(':', '')})`;
  if (privateHost(u.hostname)) return `API_PUBLIC_URL points to a local / private address (${u.hostname}) — customers' phones cannot reach it`;
  if (u.username || u.password) return 'API_PUBLIC_URL must not contain credentials';
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return 'API_PUBLIC_URL must be an origin only (no path, query or fragment)';
  return null;
}

/** Called first thing at boot. */
export function assertPublicUrl(env: NodeJS.ProcessEnv = process.env): void {
  const p = publicUrlProblem(env.API_PUBLIC_URL, env.NODE_ENV);
  if (p) {
    console.error(`[FATAL] ${p}. Refusing to start (NODE_ENV=${env.NODE_ENV ?? 'unset'}).`);
    process.exit(1);
  }
}
