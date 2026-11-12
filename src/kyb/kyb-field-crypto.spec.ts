/* eslint-disable prettier/prettier */
import { KybCrypto, KybDecryptError, KybKeyUnavailableError, lastN, maskTail } from './kyb-field-crypto';
import { isValidCnic, isValidNtn, isValidPkIban, normalizeIban } from './kyb-validators';

const k = (n: number) => Buffer.alloc(32, n).toString('base64');
const env = (o: Record<string, string | undefined>) => o as NodeJS.ProcessEnv;

describe('KybCrypto (AES-256-GCM, versioned, fail closed)', () => {
  const c1 = new KybCrypto(env({ KYB_ENC_KEY_V1: k(1), KYB_ENC_KEY_CURRENT: '1' }));

  it('round-trips, never repeats a ciphertext, and carries its key version', () => {
    const a = c1.encrypt('3520212345671', 's1:cnic'); const b = c1.encrypt('3520212345671', 's1:cnic');
    expect(a).not.toBe(b);
    expect(a.startsWith('kyb:v1:')).toBe(true);
    expect(a).not.toContain('3520212345671');
    expect(c1.decrypt(a, 's1:cnic')).toBe('3520212345671');
    expect(KybCrypto.versionOf(a)).toBe(1);
    expect(KybCrypto.isToken(a)).toBe(true);
  });
  it('a value copied to another store or field does not decrypt (AAD binding); tampering is detected', () => {
    const a = c1.encrypt('PK36SCBL0000001123456702', 's1:iban');
    expect(() => c1.decrypt(a, 's2:iban')).toThrow(KybDecryptError);
    expect(() => c1.decrypt(a, 's1:cnic')).toThrow(KybDecryptError);
    const parts = a.split(':'); parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => c1.decrypt(parts.join(':'), 's1:iban')).toThrow(KybDecryptError);
    expect(() => c1.decrypt('plain text', 's1:iban')).toThrow(KybDecryptError);
  });
  it('FAILS CLOSED: no key, no current version, a key of the wrong length — every operation throws, nothing is returned in plaintext', () => {
    for (const e of [{}, { KYB_ENC_KEY_V1: k(1) }, { KYB_ENC_KEY_CURRENT: '1' }, { KYB_ENC_KEY_V1: 'short', KYB_ENC_KEY_CURRENT: '1' }, { KYB_ENC_KEY_V1: k(1), KYB_ENC_KEY_CURRENT: 'x' }]) {
      const c = new KybCrypto(env(e));
      expect(c.isReady()).toBe(false);
      expect(() => c.encrypt('secret', 'a')).toThrow(KybKeyUnavailableError);
      expect(() => c.assertReady()).toThrow(KybKeyUnavailableError);
    }
  });
  it('ROTATION: old values decrypt with the old key until re-encrypted; re-encrypting is idempotent; the old key can then be removed', () => {
    const old = c1.encrypt('PK36SCBL0000001123456702', 's1:iban');
    const both = new KybCrypto(env({ KYB_ENC_KEY_V1: k(1), KYB_ENC_KEY_V2: k(2), KYB_ENC_KEY_CURRENT: '2' }));
    expect(both.decrypt(old, 's1:iban')).toBe('PK36SCBL0000001123456702');
    const fresh = both.reencrypt(old, 's1:iban');
    expect(KybCrypto.versionOf(fresh)).toBe(2);
    expect(both.reencrypt(fresh, 's1:iban')).toBe(fresh);
    const onlyNew = new KybCrypto(env({ KYB_ENC_KEY_V2: k(2), KYB_ENC_KEY_CURRENT: '2' }));
    expect(onlyNew.decrypt(fresh, 's1:iban')).toBe('PK36SCBL0000001123456702');
    expect(() => onlyNew.decrypt(old, 's1:iban')).toThrow(KybKeyUnavailableError); // V1 was removed too early → loud, not silent
  });
  it('masking helpers keep only the tail', () => {
    expect(maskTail('3520212345671', 4)).toBe('•••••••••5671'); expect(lastN('PK36 SCBL 0000 0011 2345 6702', 4)).toBe('6702'); expect(maskTail('12', 4)).toBe('••');
  });
});

describe('Pakistani identifier validators', () => {
  it('IBAN: PK + checksum + 24 characters', () => {
    expect(isValidPkIban('PK36SCBL0000001123456702')).toBe(true);
    expect(isValidPkIban('pk36 scbl 0000 0011 2345 6702')).toBe(true);
    expect(normalizeIban('pk36 scbl 0000 0011 2345 6702')).toBe('PK36SCBL0000001123456702');
    expect(isValidPkIban('PK37SCBL0000001123456702')).toBe(false); // bad check digits
    expect(isValidPkIban('PK36SCBL000000112345670')).toBe(false); // too short
    expect(isValidPkIban('GB82WEST12345698765432')).toBe(false); // not PK
    expect(isValidPkIban('')).toBe(false);
  });
  it('CNIC 13 digits (dashes ok); NTN 7–8 digits or a 13-digit CNIC', () => {
    expect(isValidCnic('35202-1234567-1')).toBe(true); expect(isValidCnic('3520212345671')).toBe(true); expect(isValidCnic('352021234567')).toBe(false); expect(isValidCnic('35202-123456a-1')).toBe(false);
    expect(isValidNtn('1234567-8')).toBe(true); expect(isValidNtn('1234567')).toBe(true); expect(isValidNtn('3520212345671')).toBe(true); expect(isValidNtn('12345')).toBe(false);
  });
});
