/* eslint-disable prettier/prettier */
import { base32Decode, base32Encode, generateTotpSecret, totpAt, totpAuthUri, verifyTotp, TOTP_STEP_SECONDS } from './totp.util';

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890"), SHA-1, last 6 digits of the 8-digit vectors.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const stepOf = (unixSeconds: number) => Math.floor(unixSeconds / TOTP_STEP_SECONDS);

describe('totp.util', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    expect(totpAt(RFC_SECRET, stepOf(59))).toBe('287082');
    expect(totpAt(RFC_SECRET, stepOf(1111111109))).toBe('081804');
    expect(totpAt(RFC_SECRET, stepOf(1234567890))).toBe('005924');
    expect(totpAt(RFC_SECRET, stepOf(2000000000))).toBe('279037');
  });

  it('round-trips base32', () => {
    const buf = Buffer.from('any bytes \x00\xff here');
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts the current code and one step of clock drift, returning the step', () => {
    const now = 1_700_000_000_000;
    const step = stepOf(now / 1000);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step), 1, now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 1), 1, now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step + 1), 1, now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, step - 3), 1, now)).toBeNull();
  });

  it('rejects malformed codes and tolerates a space', () => {
    const now = 1_700_000_000_000;
    const code = totpAt(RFC_SECRET, stepOf(now / 1000));
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, 1, now)).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', 1, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 1, now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '', 1, now)).toBeNull();
  });

  it('builds an otpauth URI authenticator apps understand', () => {
    expect(totpAuthUri('ABC', 'a@b.com', 'Solvexo Admin')).toBe('otpauth://totp/Solvexo%20Admin%3Aa%40b.com?secret=ABC&issuer=Solvexo%20Admin&algorithm=SHA1&digits=6&period=30');
  });
});
