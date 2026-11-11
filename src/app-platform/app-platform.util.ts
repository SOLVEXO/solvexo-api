/* eslint-disable prettier/prettier */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { API_SCOPES, WEBHOOK_EVENTS } from '../merchant-api/merchant-api.util';

export const MAX_REDIRECTS = 5;
export const CODE_TTL_MS = 10 * 60_000;
export const SESSION_TOKEN_TTL_S = 5 * 60;
export const MAX_INSTALLS_PER_STORE = 20;

export const SCOPE_LABEL: Record<string, string> = {
  read_orders: 'See your orders and customers\' delivery details', write_orders: 'See and change your orders',
  read_products: 'See your products and prices', write_products: 'Create and change your products',
  read_customers: 'See your customers', write_customers: 'Create and change your customers',
  read_inventory: 'See your stock levels', write_inventory: 'Change your stock levels',
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString('hex')}`;
export const newClientId = () => `app_${randomBytes(10).toString('hex')}`;
export const hashSecret = (s: string) => createHash('sha256').update(String(s)).digest('hex');
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(String(a), 'hex'); const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

type Ok<T> = { ok: true; data: T }; type Err = { ok: false; error: string };

/** https only, no credentials, no IP literal / localhost / single-label host, no fragment, bounded. */
export function httpsUrl(raw: unknown, what: string): Ok<string> | Err {
  let u: URL;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: `${what} must be a valid https address` }; }
  if (u.protocol !== 'https:') return { ok: false, error: `${what} must start with https://` };
  if (u.username || u.password) return { ok: false, error: `${what} must not contain a user name or password` };
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.startsWith('[') || u.hostname === 'localhost' || !u.hostname.includes('.') || /\.(local|internal|localhost)$/i.test(u.hostname)) return { ok: false, error: `${what} must use a public domain name` };
  if (u.hash) return { ok: false, error: `${what} must not contain a #fragment` };
  if (String(raw).length > 500) return { ok: false, error: `${what} is too long` };
  return { ok: true, data: u.toString() };
}

export function validateApp(body: any, partial: boolean): Ok<any> | Err {
  const d: any = {};
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  if (!partial || body?.name !== undefined) { const n = s(body?.name, 80); if (!n) return { ok: false, error: 'Name is required' }; d.name = n; }
  if (body?.description !== undefined) d.description = s(body.description, 500);
  if (body?.developerName !== undefined) d.developerName = s(body.developerName, 120);
  if (body?.developerEmail !== undefined) { const e = s(body.developerEmail, 160); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: 'Developer email is not valid' }; d.developerEmail = e; }
  if (!partial || body?.redirectUrls !== undefined) {
    const r = body?.redirectUrls;
    if (!Array.isArray(r) || r.length < 1 || r.length > MAX_REDIRECTS) return { ok: false, error: `Add 1 to ${MAX_REDIRECTS} redirect addresses` };
    const out: string[] = [];
    for (const x of r) { const v = httpsUrl(x, 'A redirect address'); if (!v.ok) return v; if (!out.includes(v.data)) out.push(v.data); }
    d.redirectUrls = out;
  }
  if (!partial || body?.requestedScopes !== undefined) {
    const sc = body?.requestedScopes;
    if (!Array.isArray(sc) || sc.length < 1 || !sc.every((x: unknown) => (API_SCOPES as readonly string[]).includes(String(x)))) return { ok: false, error: 'Choose at least one valid permission' };
    d.requestedScopes = [...new Set<string>(sc.map(String))];
  }
  for (const [key, what] of [['webhookUrl', 'The webhook address'], ['uninstallWebhookUrl', 'The uninstall webhook address'], ['embedUrl', 'The embedded page address']] as const) {
    if (body?.[key] !== undefined) { if (body[key] === null || body[key] === '') d[key] = null; else { const v = httpsUrl(body[key], what); if (!v.ok) return v; d[key] = v.data; } }
  }
  if (body?.webhookEvents !== undefined) {
    const e = body.webhookEvents;
    if (!Array.isArray(e) || e.length > WEBHOOK_EVENTS.length || !e.every((x: unknown) => (WEBHOOK_EVENTS as readonly string[]).includes(String(x)))) return { ok: false, error: 'Unknown webhook event' };
    d.webhookEvents = [...new Set<string>(e.map(String))];
  }
  if (body?.embedTitle !== undefined) d.embedTitle = s(body.embedTitle, 60);
  if (d.webhookEvents?.length && body?.webhookUrl === undefined && !partial) return { ok: false, error: 'Add the webhook address for those events' };
  return { ok: true, data: d };
}

export const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';

/** Scopes the store owner may grant: what the app asked for, nothing else. */
export function grantable(requested: string[], wanted: unknown): string[] | null {
  const w = Array.isArray(wanted) && wanted.length ? [...new Set(wanted.map(String))] : requested;
  return w.length > 0 && w.every((x) => requested.includes(x)) ? w : null;
}

/** Exact string match against the registered addresses (no prefix / wildcard / case tricks). */
export const exactRedirect = (registered: string[], given: unknown) => typeof given === 'string' && registered.includes(given);

/** HS256 token handed to an embedded app over postMessage (never in a URL). */
export function signSessionToken(secret: string, claims: { aud: string; sub: string; store: string; install: string }, nowS = Math.floor(Date.now() / 1000)): string {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: 'solvexo', ...claims, iat: nowS, exp: nowS + SESSION_TOKEN_TTL_S, jti: randomBytes(8).toString('hex') }));
  return `${head}.${body}.${b64u(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
}

export function verifySessionToken(secret: string, token: string, nowS = Math.floor(Date.now() / 1000)): { ok: true; claims: Record<string, any> } | { ok: false } {
  const [h, b, sig] = String(token).split('.');
  if (!h || !b || !sig) return { ok: false };
  const want = b64u(createHmac('sha256', secret).update(`${h}.${b}`).digest());
  const x = Buffer.from(sig); const y = Buffer.from(want);
  if (x.length !== y.length || !timingSafeEqual(x, y)) return { ok: false };
  try { const claims = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); return claims.exp > nowS && claims.iss === 'solvexo' ? { ok: true, claims } : { ok: false }; } catch { return { ok: false }; }
}
