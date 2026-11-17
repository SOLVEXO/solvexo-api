/* eslint-disable prettier/prettier */

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileResult = { ok: true } | { ok: false; reason: 'failed' | 'unreachable' | 'bad_secret' };

async function siteverify(secret: string, token: string, ip?: string): Promise<{ success: boolean; codes: string[] } | null> {
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    const json: any = await res.json();
    return { success: json?.success === true, codes: Array.isArray(json?.['error-codes']) ? json['error-codes'] : [] };
  } catch {
    return null;
  }
}

/** Asks Cloudflare whether the visitor's token is real. Fails CLOSED when Cloudflare cannot be reached: a bot must not get through because of an outage. */
export async function verifyTurnstile(secret: string, token: string | undefined, ip?: string): Promise<TurnstileResult> {
  if (!token || token.length > 2048) return { ok: false, reason: 'failed' };
  const r = await siteverify(secret, token, ip);
  if (!r) return { ok: false, reason: 'unreachable' };
  if (r.success) return { ok: true };
  return { ok: false, reason: r.codes.includes('invalid-input-secret') ? 'bad_secret' : 'failed' };
}

/**
 * Is this secret key one Cloudflare accepts? Sends a made-up token: a real secret answers "invalid-input-response",
 * a wrong secret answers "invalid-input-secret" (the same trick the customer social login uses).
 */
export async function testTurnstileSecret(secret: string): Promise<'ok' | 'bad_secret' | 'unreachable'> {
  const r = await siteverify(secret, 'solvexo-key-check');
  if (!r) return 'unreachable';
  return r.codes.includes('invalid-input-secret') || r.codes.includes('missing-input-secret') ? 'bad_secret' : 'ok';
}
