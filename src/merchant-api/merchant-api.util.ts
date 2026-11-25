/* eslint-disable prettier/prettier */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { isIP } from 'net';

export const WEBHOOK_EVENTS = ['order.created', 'order.paid', 'order.fulfilled', 'order.cancelled', 'refund.created', 'product.updated', 'inventory.changed', 'customer.created', 'form.submitted'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** The read permission a token needs to subscribe to each event (it would otherwise learn data it may not read). */
export const EVENT_SCOPE: Record<string, string> = {
  'order.created': 'read_orders', 'order.paid': 'read_orders', 'order.fulfilled': 'read_orders', 'order.cancelled': 'read_orders', 'refund.created': 'read_orders',
  'product.updated': 'read_products', 'inventory.changed': 'read_inventory', 'customer.created': 'read_customers', 'form.submitted': 'read_customers',
};
/** Webhooks one API token may create through the API (Zapier makes one per Zap). */
export const MAX_TOKEN_WEBHOOKS = 50;

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

// ── Paging for the public API (v1) ──────────────────────────────────────────

/** 120 requests a minute per token; every answer carries X-RateLimit-Limit / -Remaining / -Reset. */
export const API_RATE_LIMIT_PER_MIN = 120;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Opaque cursor: base64url of the last returned `_id`. Lists run newest first (descending `_id`). */
export const encodeCursor = (id: string) => Buffer.from(`v1:${id}`).toString('base64url');
export function decodeCursor(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const s = Buffer.from(raw, 'base64url').toString('utf8');
  const m = /^v1:([a-f0-9]{24})$/i.exec(s);
  return m ? m[1] : null;
}

export class ListQueryError extends Error {}

/** `limit`, `cursor`, `updated_since` (ISO date). Throws ListQueryError on a bad value so the caller can answer 400. */
export function parseListQuery(q: any): { limit: number; afterId: string | null; updatedSince: Date | null } {
  const limit = q?.limit === undefined ? DEFAULT_PAGE_SIZE : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new ListQueryError(`limit must be a whole number from 1 to ${MAX_PAGE_SIZE}`);
  let afterId: string | null = null;
  if (q?.cursor !== undefined && q.cursor !== '') { afterId = decodeCursor(q.cursor); if (!afterId) throw new ListQueryError('cursor is invalid; use next_cursor from the previous page'); }
  let updatedSince: Date | null = null;
  if (q?.updated_since !== undefined && q.updated_since !== '') {
    updatedSince = new Date(String(q.updated_since));
    if (Number.isNaN(updatedSince.getTime())) throw new ListQueryError('updated_since must be an ISO 8601 date-time, e.g. 2026-11-01T00:00:00Z');
  }
  return { limit, afterId, updatedSince };
}

/** One page from rows fetched with limit+1: `has_more` and the cursor for the next call. */
export function pageOf<T>(rows: any[], limit: number, map: (r: any) => T) {
  const has_more = rows.length > limit;
  const slice = has_more ? rows.slice(0, limit) : rows;
  return { items: slice.map(map), has_more, next_cursor: has_more ? encodeCursor(String(slice[slice.length - 1]._id)) : null };
}

/** Fixed window per key, with what is left (for X-RateLimit-* headers). */
export function makeRateLimiterInfo(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string, now = Date.now()): { ok: boolean; limit: number; remaining: number; resetS: number } => {
    let h = hits.get(key);
    if (!h || h.reset <= now) { if (hits.size > 5000) hits.clear(); h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n += 1;
    return { ok: h.n <= limit, limit, remaining: Math.max(0, limit - h.n), resetS: Math.ceil((h.reset - now) / 1000) };
  };
}
