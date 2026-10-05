/* eslint-disable prettier/prettier */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Shopify's "order status page" link: a signed, unguessable token that opens ONE order without logging in (this is how
 * a guest checks their order). Stateless HMAC over `{ orderId, exp }` with the server's JWT_SECRET — no DB, no new
 * dependency. The token is a capability: anyone holding the link can view that order (and nothing else).
 */
const DAYS = 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function signOrderStatusToken(orderId: string, validForDays = 365): string {
  const body = b64(JSON.stringify({ o: String(orderId), e: Date.now() + validForDays * DAYS, p: 'order_status' }));
  const sig = b64(createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns the orderId, or null when the token is malformed, forged or expired. */
export function verifyOrderStatusToken(token: string): string | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.p !== 'order_status' || typeof p.o !== 'string' || typeof p.e !== 'number' || p.e < Date.now()) return null;
    return p.o;
  } catch { return null; }
}
