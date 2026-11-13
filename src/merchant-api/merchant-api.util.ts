/* eslint-disable prettier/prettier */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

export const WEBHOOK_EVENTS = ['order.created', 'order.paid', 'order.fulfilled', 'order.cancelled', 'refund.created', 'product.updated', 'inventory.changed', 'customer.created', 'form.submitted'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const API_SCOPES = ['read_orders', 'write_orders', 'read_products', 'write_products', 'read_customers', 'write_customers', 'read_inventory', 'write_inventory'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

/** Retry delays after a failed attempt (ms): 1 min, 5 min, 30 min, 2 h, 6 h. After that the delivery is marked failed. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** A subscription is switched off after this many deliveries in a row ended in failure. */
export const AUTO_DISABLE_AFTER = 15;
export const SIGNATURE_TOLERANCE_S = 300;

/** Backoff for the delivery that just failed on `attempt` (1-based); null = give up. */
export const nextDelayMs = (attempt: number): number | null => (attempt >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MS[attempt - 1]);

/** Header value `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. The receiver rejects an old `t` (replay). */
export function signPayload(secret: string, body: string, timestampS = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampS},v1=${createHmac('sha256', secret).update(`${timestampS}.${body}`).digest('hex')}`;
}

export function verifySignature(secret: string, body: string, header: string, nowS = Math.floor(Date.now() / 1000), toleranceS = SIGNATURE_TOLERANCE_S): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));
  if (!m) return false;
  if (Math.abs(nowS - Number(m[1])) > toleranceS) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex'));
  return timingSafeEqual(want, Buffer.from(m[2]));
}

export const newSecret = () => `whsec_${randomBytes(24).toString('hex')}`;

/** https only, a public host NAME (no IPs, no localhost, no credentials, no odd ports). The delivery also re-checks DNS. */
export function validateWebhookUrl(raw: unknown): string | null {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return 'Enter a valid https address'; }
  if (u.protocol !== 'https:') return 'The address must start with https://';
  if (u.username || u.password) return 'The address must not contain a user name or password';
  if (isIP(u.hostname) || u.hostname.startsWith('[')) return 'Use a domain name, not an IP address';
  if (u.hostname === 'localhost' || !u.hostname.includes('.') || /\.(local|internal|localhost)$/i.test(u.hostname)) return 'The address must be a public domain';
  if (u.port && u.port !== '443') return 'Only the standard https port is allowed';
  if (String(raw).length > 500) return 'The address is too long';
  return null;
}

/** API token = `sxk_` + 40 hex. Only the SHA-256 is stored; the plain token is shown once. */
export function generateToken(): { token: string; hash: string; prefix: string } {
  const token = `sxk_${randomBytes(20).toString('hex')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 8) };
}
export const hashToken = (t: string) => createHash('sha256').update(String(t)).digest('hex');

/** A write scope implies the read of the same resource. */
export function scopeAllows(granted: string[] | undefined, needed: ApiScope): boolean {
  const g = granted ?? [];
  return g.includes(needed) || (needed.startsWith('read_') && g.includes(`write_${needed.slice(5)}`));
}

export const validEvents = (v: unknown): WebhookEvent[] | null => {
  if (!Array.isArray(v) || v.length === 0) return null;
  const set = [...new Set(v.map(String))];
  return set.every((e) => (WEBHOOK_EVENTS as readonly string[]).includes(e)) ? (set as WebhookEvent[]) : null;
};
export const validScopes = (v: unknown): ApiScope[] | null => {
  if (!Array.isArray(v) || v.length === 0) return null;
  const set = [...new Set(v.map(String))];
  return set.every((s) => (API_SCOPES as readonly string[]).includes(s)) ? (set as ApiScope[]) : null;
};

/** Small in-memory fixed-window limiter (per API token). */
export function makeRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, now = Date.now()): boolean => {
    const h = hits.get(key);
    if (!h || h.reset <= now) { if (hits.size > 5000) hits.clear(); hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    h.n += 1; return h.n <= limit;
  };
}
