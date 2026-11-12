/* eslint-disable prettier/prettier */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * The link in a "please confirm your cash-on-delivery order" message. Stateless HMAC like `order-status-token.util.ts`, with its own
 * purpose so no other link can confirm an order. It carries the order id, a per-send id (`t`, also stored on the order: sending again
 * invalidates every older link) and the moment the confirmation window closes. Who holds the link can confirm or cancel THAT order only.
 */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}
const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export interface CodConfirmClaims { orderId: string; tokenId: string; expiresAt: number }

export function signCodConfirmToken(orderId: string, tokenId: string, expiresAt: Date | number): string {
  const body = b64(JSON.stringify({ o: String(orderId), t: tokenId, e: +expiresAt, p: 'cod_confirm' }));
  return `${body}.${b64(createHmac('sha256', secret()).update(body).digest())}`;
}

/** The claims, or null when the token is malformed, forged, expired or made for something else. */
export function verifyCodConfirmToken(token: string, now = Date.now()): CodConfirmClaims | null {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let given: Buffer;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p?.p !== 'cod_confirm' || typeof p.o !== 'string' || typeof p.t !== 'string' || typeof p.e !== 'number' || p.e < now) return null;
    return { orderId: p.o, tokenId: p.t, expiresAt: p.e };
  } catch { return null; }
}
