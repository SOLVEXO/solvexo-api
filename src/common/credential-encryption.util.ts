/* eslint-disable prettier/prettier */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * AES-256-GCM encrypt/decrypt for third-party integration credentials
 * (payment gateway API keys/secrets, WhatsApp Cloud access tokens) stored on
 * `StoreIntegration` documents. Same algorithm and payload shape as
 * `seo-token-encryption.util.ts`, forked rather than reused so a leaked or
 * rotated key on one feature doesn't affect the other — deliberately keyed
 * by name so each caller states which secret family it's touching.
 *
 * Key material comes from `<KEY_NAME>_CREDENTIALS_ENCRYPTION_KEY` (any length
 * string — run through scrypt to derive a proper 32-byte key). Each
 * ciphertext carries its own random IV + auth tag so the same plaintext never
 * produces the same ciphertext twice.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

const KEY_ENV_VARS = {
  INTEGRATIONS: 'INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY',
} as const;

export type CredentialKeyName = keyof typeof KEY_ENV_VARS;

function deriveKey(keyName: CredentialKeyName): Buffer {
  const envVar = KEY_ENV_VARS[keyName];
  const secret = process.env[envVar];
  if (!secret) {
    throw new Error(`${envVar} is not set — refusing to encrypt/decrypt ${keyName} credentials without a real key.`);
  }
  // Static, key-specific salt is acceptable here: the secret itself is the
  // actual entropy source (an env var, not a user password), and scrypt is
  // only being used as a KDF to normalize arbitrary-length input into a
  // 32-byte key.
  return scryptSync(secret, `solvexo-${keyName.toLowerCase()}-credential-salt`, 32);
}

export function encryptCredential(plaintext: string, keyName: CredentialKeyName): string {
  const key = deriveKey(keyName);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext, all base64 — self-describing, no separate metadata needed.
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptCredential(payload: string, keyName: CredentialKeyName): string {
  const parts = payload.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1]) {
    // iv/authTag are always non-empty (fixed byte lengths); ciphertext
    // legitimately can be empty when the original plaintext was empty.
    throw new Error('Malformed encrypted credential payload.');
  }
  const [ivB64, authTagB64, dataB64] = parts;
  const key = deriveKey(keyName);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Last-4 display mask for confirming a stored secret back to the seller without ever exposing it. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return '••••';
  return `••••${plaintext.slice(-4)}`;
}
