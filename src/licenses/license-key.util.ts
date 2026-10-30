import { createHash, randomInt, timingSafeEqual } from 'crypto';

// no 0/O/1/I/L so a key can be read out over the phone
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** XXXX-XXXX-XXXX-XXXX from crypto.randomInt (about 79 bits). */
export function generateLicenseKey(): string {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return [group(), group(), group(), group()].join('-');
}

/** Upper-case, dashes/spaces ignored, so "abcd efgh..." validates the same as the printed key. */
export function normalizeKey(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const isWellFormedKey = (raw: string): boolean => normalizeKey(raw).length === 16;

export const hashKey = (raw: string): string => createHash('sha256').update(normalizeKey(raw)).digest('hex');

export const hashToken = (token: string): string => createHash('sha256').update(String(token)).digest('hex');

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Device ids are hashed so the seller never stores a raw machine id. */
export const hashDevice = (storeId: string, deviceId: string): string =>
  createHash('sha256').update(`${storeId}:${String(deviceId).slice(0, 200)}`).digest('hex');
