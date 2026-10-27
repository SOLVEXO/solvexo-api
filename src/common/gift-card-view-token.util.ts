/* eslint-disable prettier/prettier */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Shopify's gift card page link: a signed, unguessable token that opens ONE gift card (its code and balance) without
 * logging in, so the person who received the email can see and copy the code. Same stateless HMAC idea as
 * `order-status-token.util.ts`, with its own `p` purpose so an order link can never open a gift card (or the reverse).
 * The token is a capability: whoever holds the link can see that card, and nothing else.
 */
const DAYS = 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function signGiftCardViewToken(giftCardId: string, validForDays = 3 * 365): string {
  const body = b64(JSON.stringify({ g: String(giftCardId), e: Date.now() + validForDays * DAYS, p: 'gift_card_view' }));
  const sig = b64(createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}

/** Returns the gift card id, or null when the token is malformed, forged, expired or made for something else. */
export function verifyGiftCardViewToken(token: string): string | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.p !== 'gift_card_view' || typeof p.g !== 'string' || typeof p.e !== 'number' || p.e < Date.now()) return null;
    return p.g;
  } catch { return null; }
}
