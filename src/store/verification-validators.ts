/* eslint-disable prettier/prettier */
// Pure format validators for Pakistani seller identifiers. The web form shows
// the same hints, but these are the authority (StoreService.updateVerification
// rejects a bad format with a 400 carrying the messages below).

/** CNIC: 13 digits, with or without dashes → normalized `12345-1234567-1`; null when the format is wrong. */
export function normalizeCnic(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!/^(\d{5}-\d{7}-\d|\d{13})$/.test(raw)) return null;
  const d = raw.replace(/-/g, '');
  return `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`;
}

/**
 * NTN: 7 digits + check digit, `1234567-8` or `12345678` → normalized `1234567-8`. Individuals registered
 * with FBR since 2019 use their 13-digit CNIC as their NTN, so a CNIC-format value is accepted too
 * (normalized `12345-1234567-1`). Null when the format is wrong.
 */
export function normalizeNtn(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const asCnic = normalizeCnic(raw);
  if (asCnic) return asCnic;
  if (!/^(\d{7}-\d|\d{8})$/.test(raw)) return null;
  const d = raw.replace(/-/g, '');
  return `${d.slice(0, 7)}-${d.slice(7)}`;
}

export const isValidCnic = (input: unknown) => normalizeCnic(input) !== null;
export const isValidNtn = (input: unknown) => normalizeNtn(input) !== null;

export const CNIC_FORMAT_MESSAGE = 'CNIC must be 13 digits, e.g. 12345-1234567-1';
export const NTN_FORMAT_MESSAGE = 'NTN must be 7 digits and a check digit (e.g. 1234567-8), or your 13-digit CNIC if FBR issued your NTN on your CNIC';
