/* eslint-disable prettier/prettier */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Unsubscribe link for mails that go to a shopper who is NOT on the store's subscriber list (the abandoned-cart reminder).
 * A signed, stateless token that says "stop marketing mail from THIS store to THIS address", so no subscriber row has to exist
 * first. Own `p` purpose: an order, gift card or any other signed link can never be used as an unsubscribe (or the reverse).
 */
const DAYS = 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function signMarketingOptOutToken(storeId: string, email: string, validForDays = 3 * 365): string {
  const body = b64(JSON.stringify({ s: String(storeId), m: String(email).trim().toLowerCase(), e: Date.now() + validForDays * DAYS, p: 'marketing_optout' }));
  const sig = b64(createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns `{ storeId, email }`, or null when the token is malformed, forged, expired or made for something else. */
export function verifyMarketingOptOutToken(token: string): { storeId: string; email: string } | null {
  if (typeof token !== 'string' || token.length > 800) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.p !== 'marketing_optout' || typeof p.s !== 'string' || typeof p.m !== 'string' || typeof p.e !== 'number' || p.e < Date.now()) return null;
    return { storeId: p.s, email: p.m };
  } catch { return null; }
}
