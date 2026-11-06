/* eslint-disable prettier/prettier */
/** Pakistani identifiers. Strict about shape, lenient about separators; pure functions so they are unit-tested and reused by the DTO layer. */

export const normalizeCnic = (v: string): string => v.replace(/[\s-]/g, '');
/** CNIC: 13 digits (e.g. 35202-1234567-1). */
export const isValidCnic = (v: string): boolean => /^\d{13}$/.test(normalizeCnic(v));

export const normalizeNtn = (v: string): string => v.replace(/[\s-]/g, '');
/** NTN: 7 digits + optional check digit, or a 13-digit CNIC used as NTN for individuals. */
export const isValidNtn = (v: string): boolean => /^(\d{7,8}|\d{13})$/.test(normalizeNtn(v));

export const normalizeIban = (v: string): string => v.replace(/\s+/g, '').toUpperCase();
/** Pakistan IBAN: `PK` + 2 check digits + 4-letter bank code + 16 alphanumerics = 24 characters, ISO 13616 mod-97 checksum. */
export function isValidPkIban(v: string): boolean {
  const iban = normalizeIban(v);
  if (!/^PK\d{2}[A-Z]{4}[A-Z0-9]{16}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}


/** Largest KYB document accepted. Configurable with KYB_MAX_FILE_BYTES (default 10 MB). */
export function kybMaxFileBytes(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.KYB_MAX_FILE_BYTES);
  return Number.isFinite(n) && n >= 1024 ? Math.floor(n) : 10 * 1024 * 1024;
}

/**
 * What a document REALLY is, from its first bytes — never from its extension or the client's Content-Type.
 * JPEG (FF D8 FF), PNG (89 50 4E 47 0D 0A 1A 0A), PDF (`%PDF-` within the first 1024 bytes, as real PDFs may start with a few bytes of junk).
 */
export function detectKybMime(buf: Buffer | undefined | null): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (!buf || buf.length < 5) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, Math.min(buf.length, 1024)).includes(Buffer.from('%PDF-'))) return 'application/pdf';
  return null;
}
