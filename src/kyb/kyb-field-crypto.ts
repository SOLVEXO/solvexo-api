/* eslint-disable prettier/prettier */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Field-level encryption for KYB data (CNIC, NTN, IBAN, account title). Node's built-in crypto only — no package.
 *
 *   token = "kyb:v<version>:<iv b64url>:<tag b64url>:<ciphertext b64url>"      AES-256-GCM, random 12-byte IV per value
 *
 * KEYS (one set per environment — never shared between dev/staging/production, never committed):
 *   KYB_ENC_KEY_V1, KYB_ENC_KEY_V2, …   each is 32 random bytes, base64 (generate: `openssl rand -base64 32`)
 *   KYB_ENC_KEY_CURRENT                 the version used for NEW writes, e.g. "2"
 * Every stored value carries its key version, so after adding V2 and setting CURRENT=2, old values still decrypt with V1 until the
 * rotation script (`npm run kyb:rotate-key`) re-encrypts them; V1 is removed only after the script reports 0 remaining.
 *
 * The additional authenticated data binds a ciphertext to its place (`<storeId>:<field>`): a value copied to another store or field fails
 * to decrypt. FAIL CLOSED: with no usable key every encrypt/decrypt throws `KybKeyUnavailableError` — plaintext is never stored.
 */
export class KybKeyUnavailableError extends Error {
  constructor(message = 'KYB encryption key is not configured') { super(message); this.name = 'KybKeyUnavailableError'; }
}
export class KybDecryptError extends Error {
  constructor(message = 'KYB value could not be decrypted') { super(message); this.name = 'KybDecryptError'; }
}

const PREFIX = 'kyb';
const b64 = (b: Buffer) => b.toString('base64url');

export class KybCrypto {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  private keyFor(version: number): Buffer {
    const raw = this.env[`KYB_ENC_KEY_V${version}`];
    if (!raw) throw new KybKeyUnavailableError(`KYB_ENC_KEY_V${version} is not set`);
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new KybKeyUnavailableError(`KYB_ENC_KEY_V${version} must be 32 bytes, base64-encoded`);
    return key;
  }

  /** The version used for new writes. Throws when unset or when that key is missing/invalid. */
  currentVersion(): number {
    const v = Number(this.env.KYB_ENC_KEY_CURRENT);
    if (!Number.isInteger(v) || v < 1) throw new KybKeyUnavailableError('KYB_ENC_KEY_CURRENT is not set');
    this.keyFor(v);
    return v;
  }

  /** True when encryption can be used right now (does not throw). */
  isReady(): boolean { try { this.currentVersion(); return true; } catch { return false; } }

  assertReady(): void { this.currentVersion(); }

  encrypt(plain: string, aad: string): string {
    const version = this.currentVersion();
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.keyFor(version), iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${PREFIX}:v${version}:${b64(iv)}:${b64(c.getAuthTag())}:${b64(ct)}`;
  }

  static isToken(v: unknown): v is string { return typeof v === 'string' && /^kyb:v\d+:[\w-]+:[\w-]+:[\w-]*$/.test(v); }
  static versionOf(token: string): number | null { const m = /^kyb:v(\d+):/.exec(token); return m ? Number(m[1]) : null; }

  decrypt(token: string, aad: string): string {
    const m = /^kyb:v(\d+):([\w-]+):([\w-]+):([\w-]*)$/.exec(token);
    if (!m) throw new KybDecryptError('Not a KYB token');
    const key = this.keyFor(Number(m[1])); // KybKeyUnavailableError if that version's key was removed
    try {
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(m[2], 'base64url'));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(m[3], 'base64url'));
      return Buffer.concat([d.update(Buffer.from(m[4], 'base64url')), d.final()]).toString('utf8');
    } catch { throw new KybDecryptError(); }
  }

  /** Re-encrypts with the CURRENT key. Returns the same token untouched when it is already current (idempotent). */
  reencrypt(token: string, aad: string): string {
    if (KybCrypto.versionOf(token) === this.currentVersion()) return token;
    return this.encrypt(this.decrypt(token, aad), aad);
  }
}

/** `PK••••••••••••••••1234`-style mask keeping only the last `keep` characters. */
export function maskTail(plain: string, keep = 4, prefixLen = 0): string {
  const s = plain.replace(/\s+/g, '');
  if (s.length <= keep) return '•'.repeat(s.length);
  return s.slice(0, prefixLen) + '•'.repeat(Math.max(0, s.length - keep - prefixLen)) + s.slice(-keep);
}
export const lastN = (plain: string, n = 4): string => plain.replace(/\s+/g, '').slice(-n);
