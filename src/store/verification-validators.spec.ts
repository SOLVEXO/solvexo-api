import { isValidCnic, isValidNtn, normalizeCnic, normalizeNtn } from './verification-validators';

describe('verification validators', () => {
  it('normalizes a CNIC with or without dashes', () => {
    expect(normalizeCnic('12345-1234567-1')).toBe('12345-1234567-1');
    expect(normalizeCnic('1234512345671')).toBe('12345-1234567-1');
    expect(normalizeCnic(' 1234512345671 ')).toBe('12345-1234567-1');
  });

  it('rejects malformed CNICs', () => {
    for (const bad of ['123451234567', '12345123456712', '1234-51234567-1', '12345-123456-71', 'abcde-1234567-1', '', null, undefined, 1234512345671]) {
      expect(normalizeCnic(bad as any)).toBeNull();
      expect(isValidCnic(bad as any)).toBe(false);
    }
  });

  it('normalizes an NTN (7 digits + check digit)', () => {
    expect(normalizeNtn('1234567-8')).toBe('1234567-8');
    expect(normalizeNtn('12345678')).toBe('1234567-8');
    expect(isValidNtn('0712345-6')).toBe(true);
  });

  it('accepts a CNIC used as NTN (individuals registered since 2019)', () => {
    expect(normalizeNtn('12345-1234567-1')).toBe('12345-1234567-1');
    expect(normalizeNtn('1234512345671')).toBe('12345-1234567-1');
  });

  it('rejects malformed NTNs', () => {
    for (const bad of ['1234567', '123456789', '123456-78', '1234567-89', 'A234567-8', '12345-123456-71', '', null]) {
      expect(normalizeNtn(bad as any)).toBeNull();
    }
  });
});
