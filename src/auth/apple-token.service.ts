/* eslint-disable prettier/prettier */
import { createCipheriv, createDecipheriv, createPrivateKey, randomBytes, sign as cryptoSign } from 'crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { DatabaseService } from '@/database/databaseservice';

/** HTTP seam to Apple — replaced in tests so nothing ever calls appleid.apple.com. */
export abstract class AppleAuthClient {
  /** Exchanges a Sign in with Apple authorization code; resolves the Apple refresh_token. */
  abstract exchangeCode(code: string, clientId: string): Promise<string>;
  /** Revokes an Apple refresh token. Throws on any non-success. */
  abstract revoke(refreshToken: string, clientId: string): Promise<void>;
}

const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';

export const appleConfigured = (): boolean => !!(process.env.APPLE_PRIVATE_KEY && process.env.APPLE_KEY_ID && process.env.APPLE_TEAM_ID);

/** Apple client secret: a short-lived ES256 JWT signed with the .p8 key (iss=team, sub=client id, aud=https://appleid.apple.com). */
export function buildAppleClientSecret(clientId: string, now = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'ES256', kid: process.env.APPLE_KEY_ID, typ: 'JWT' };
  const payload = { iss: process.env.APPLE_TEAM_ID, iat: now, exp: now + 300, aud: 'https://appleid.apple.com', sub: clientId };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${b64(header)}.${b64(payload)}`;
  const pem = String(process.env.APPLE_PRIVATE_KEY).replace(/\\n/g, '\n');
  const sig = cryptoSign('sha256', Buffer.from(input), { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

export class FetchAppleAuthClient extends AppleAuthClient {
  private async post(url: string, form: Record<string, string>) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Apple responded ${res.status}${(() => { try { return ` ${JSON.parse(text).error ?? ''}`; } catch { return ''; } })()}`);
    return text;
  }
  async exchangeCode(code: string, clientId: string) {
    const text = await this.post(APPLE_TOKEN_URL, { client_id: clientId, client_secret: buildAppleClientSecret(clientId), code, grant_type: 'authorization_code' });
    const rt = JSON.parse(text)?.refresh_token;
    if (!rt) throw new Error('Apple returned no refresh_token');
    return String(rt);
  }
  async revoke(refreshToken: string, clientId: string) {
    await this.post(APPLE_REVOKE_URL, { client_id: clientId, client_secret: buildAppleClientSecret(clientId), token: refreshToken, token_type_hint: 'refresh_token' });
  }
}

// ── encryption at rest: AES-256-GCM, versioned envelope `v1:<iv>.<tag>.<ciphertext>` (base64url) ─────────────────────
function encKey(): Buffer {
  const raw = process.env.APPLE_TOKEN_ENC_KEY;
  const key = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('APPLE_TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
  return key;
}
export function encryptAppleToken(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function decryptAppleToken(envelope: string): string {
  if (!envelope?.startsWith('v1:')) throw new Error('Unknown envelope version');
  const [iv, tag, ct] = envelope.slice(3).split('.');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export const MAX_REVOKE_ATTEMPTS = 8;
const HOUR = 3_600_000;
const backoffMs = (attempts: number) => Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, attempts - 1));
/** Never let a secret or token reach logs/DB: keep only a short, scrubbed reason. */
const scrub = (e: any) => String(e?.message ?? e ?? 'error').replace(/[A-Za-z0-9_\-.]{40,}/g, '[redacted]').slice(0, 200);

/**
 * Sign in with Apple token lifecycle (App Store 5.1.1(v): revoke Apple tokens when the account is deleted).
 *  - at sign-in: exchange the authorization code, store the Apple refresh token encrypted. Never fails the login.
 *  - at PURGE (not at the request: the account is recoverable for 30 days): revoke at Apple. Never blocks deletion;
 *    a failure is recorded on the seller (`appleRevocation`) and retried hourly with backoff, then given up loudly.
 */
@Injectable()
export class AppleTokenService {
  private readonly logger = new Logger(AppleTokenService.name);
  private readonly client: AppleAuthClient;
  constructor(private readonly db: DatabaseService, @Optional() client?: AppleAuthClient) { this.client = client ?? new FetchAppleAuthClient(); }
  private get sellers() { return (this.db.repositories as any).sellerModel; }

  /** Called from the Apple sign-in path. Swallows every error. */
  async storeFromAuthorizationCode(sellerId: string, code: string | undefined, clientId: string | undefined): Promise<void> {
    if (!code) return;
    try {
      if (!appleConfigured() || !process.env.APPLE_TOKEN_ENC_KEY) { this.logger.warn('Apple token not stored: APPLE_PRIVATE_KEY/KEY_ID/TEAM_ID or APPLE_TOKEN_ENC_KEY missing'); return; }
      const cid = clientId || (process.env.APPLE_CLIENT_ID ?? '').split(',')[0]?.trim();
      if (!cid) { this.logger.warn('Apple token not stored: no client id'); return; }
      const rt = await this.client.exchangeCode(code, cid);
      await this.sellers.updateOne({ _id: sellerId }, { $set: { appleRefreshTokenEnc: encryptAppleToken(rt), appleClientId: cid, appleRevocation: null } });
    } catch (e) {
      this.logger.warn(`Apple code exchange failed (login continues): ${scrub(e)}`);
    }
  }

  /** Revokes this seller's Apple token if there is one. Returns what happened; never throws. */
  async revokeForSeller(sellerId: string, now = new Date()): Promise<'none' | 'revoked' | 'skipped' | 'retry' | 'gave_up'> {
    const seller: any = await this.sellers.findById(sellerId).select('+appleRefreshTokenEnc +appleClientId appleRevocation');
    if (!seller?.appleRefreshTokenEnc) return 'none';
    const attempts = (seller.appleRevocation?.attempts ?? 0);
    const record = async (patch: any) => { await this.sellers.collection.updateOne({ _id: seller._id }, { $set: { appleRevocation: { status: 'pending', attempts, nextAttemptAt: null, lastError: null, ...seller.appleRevocation, ...patch } } }); };
    if (!appleConfigured() || !process.env.APPLE_TOKEN_ENC_KEY) {
      this.logger.warn(`Apple revocation skipped for seller ${sellerId}: Apple credentials/APPLE_TOKEN_ENC_KEY not configured (token kept; retried hourly once configured)`);
      await record({ status: 'pending', lastError: 'not_configured', nextAttemptAt: new Date(now.getTime() + HOUR) });
      return 'skipped';
    }
    try {
      await this.client.revoke(decryptAppleToken(seller.appleRefreshTokenEnc), seller.appleClientId || (process.env.APPLE_CLIENT_ID ?? '').split(',')[0].trim());
      await this.sellers.collection.updateOne({ _id: seller._id }, { $set: { appleRefreshTokenEnc: null, appleClientId: null, appleRevocation: { status: 'done', attempts: attempts + 1, nextAttemptAt: null, lastError: null, doneAt: now } } });
      return 'revoked';
    } catch (e) {
      const n = attempts + 1;
      if (n >= MAX_REVOKE_ATTEMPTS) {
        this.logger.error(`APPLE REVOCATION GAVE UP for seller ${sellerId} after ${n} attempts: ${scrub(e)} — revoke manually in the Apple ID settings/API`);
        await record({ status: 'failed', attempts: n, nextAttemptAt: null, lastError: scrub(e) });
        return 'gave_up';
      }
      this.logger.warn(`Apple revocation failed for seller ${sellerId} (attempt ${n}, will retry): ${scrub(e)}`);
      await record({ status: 'pending', attempts: n, nextAttemptAt: new Date(now.getTime() + backoffMs(n)), lastError: scrub(e) });
      return 'retry';
    }
  }

  /** Cron: retries every purged account whose revocation is still pending and due. */
  async retryDue(now = new Date()): Promise<number> {
    const due: any[] = await this.sellers.find({ isDelete: true, 'appleRevocation.status': 'pending', 'appleRevocation.nextAttemptAt': { $lte: now } }).select('_id').lean();
    for (const s of due) await this.revokeForSeller(String(s._id), now);
    return due.length;
  }
}
