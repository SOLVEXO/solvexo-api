/* eslint-disable prettier/prettier */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { parsePortalOrigins } from '../common/portal-origins.util';

/**
 * Portal-only cookie session helpers (5G.1). The mobile apps NEVER use these: cookie mode is opt-in per request with
 * `X-Auth-Mode: cookie`, so the body-token flow the apps rely on is untouched.
 *
 *  - `solvexo_rt`   refresh token. HttpOnly, SameSite=Lax, Path=/api/auth/refresh, Max-Age 7d.
 *  - `solvexo_csrf` signed double-submit CSRF cookie. HttpOnly, SameSite=Lax, Path=/api/auth.
 */
export const REFRESH_COOKIE = 'solvexo_rt';
export const CSRF_COOKIE = 'solvexo_csrf';
export const REFRESH_COOKIE_PATH = '/api/auth/refresh';
export const CSRF_COOKIE_PATH = '/api/auth';
export const REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CSRF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const isCookieMode = (req: any): boolean => String(req?.headers?.['x-auth-mode'] ?? '').toLowerCase() === 'cookie';

/** Secure everywhere except plain-http localhost in a non-production process (local dev). */
function isSecure(req: any): boolean {
  const host = String(req?.headers?.host ?? '');
  const localHttp = process.env.NODE_ENV !== 'production' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) && req?.protocol !== 'https';
  return !localHttp;
}

function baseOptions(req: any, path: string, maxAge: number) {
  const domain = (process.env.AUTH_COOKIE_DOMAIN ?? '').trim();
  return { httpOnly: true, secure: isSecure(req), sameSite: 'lax' as const, path, maxAge, ...(domain ? { domain } : {}) };
}

export function setRefreshCookie(req: any, res: any, token: string) {
  res.cookie(REFRESH_COOKIE, token, baseOptions(req, REFRESH_COOKIE_PATH, REFRESH_MAX_AGE_MS));
}
export function clearRefreshCookie(req: any, res: any) {
  const { maxAge, ...opts } = baseOptions(req, REFRESH_COOKIE_PATH, 0);
  res.clearCookie(REFRESH_COOKIE, opts);
}

// ── CSRF (signed double-submit) ────────────────────────────────────────────────────────────────────────────────────
function csrfKey(): string {
  const explicit = process.env.CSRF_SECRET;
  if (explicit) return explicit;
  // Distinct label so the derived key can never double as the JWT secret.
  return createHmac('sha256', process.env.JWT_SECRET ?? 'dev-only-insecure').update('solvexo-csrf-key-v1').digest('hex');
}
const sign = (nonce: string) => createHmac('sha256', csrfKey()).update(`csrf:${nonce}`).digest('base64url');
const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Mints a fresh CSRF pair: `token` goes in the JSON body (readable only by an origin CORS lets in), `cookieValue` in the cookie. */
export function mintCsrf(): { token: string; cookieValue: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, cookieValue: `${token}.${sign(token)}` };
}
export function setCsrfCookie(req: any, res: any, cookieValue: string) {
  res.cookie(CSRF_COOKIE, cookieValue, baseOptions(req, CSRF_COOKIE_PATH, CSRF_MAX_AGE_MS));
}
export function issueCsrf(req: any, res: any): string {
  const { token, cookieValue } = mintCsrf();
  setCsrfCookie(req, res, cookieValue);
  return token;
}

/** Origin (fallback Referer's origin) must be one of PORTAL_ORIGINS — a missing or foreign origin is refused. */
export function assertPortalOrigin(req: any) {
  const allowed = parsePortalOrigins(process.env.PORTAL_ORIGINS);
  let origin = req?.headers?.origin as string | undefined;
  if (!origin && req?.headers?.referer) {
    try { origin = new URL(String(req.headers.referer)).origin; } catch { origin = undefined; }
  }
  if (!origin || !allowed.includes(origin)) {
    throw new ForbiddenException({ statusCode: 403, code: 'CSRF_ORIGIN', message: 'Request origin is not allowed' });
  }
}

/** Origin check + `X-CSRF-Token` header must equal the nonce inside the HMAC-valid `solvexo_csrf` cookie. */
export function assertCsrf(req: any) {
  assertPortalOrigin(req);
  const header = String(req?.headers?.['x-csrf-token'] ?? '');
  const cookie = String(req?.cookies?.[CSRF_COOKIE] ?? '');
  const dot = cookie.lastIndexOf('.');
  const nonce = dot > 0 ? cookie.slice(0, dot) : '';
  const mac = dot > 0 ? cookie.slice(dot + 1) : '';
  if (!header || !nonce || !mac || !safeEq(mac, sign(nonce)) || !safeEq(header, nonce)) {
    throw new ForbiddenException({ statusCode: 403, code: 'CSRF_TOKEN', message: 'Missing or invalid CSRF token' });
  }
}

export const hashJti = (jti: string) => createHash('sha256').update(jti).digest('hex');
