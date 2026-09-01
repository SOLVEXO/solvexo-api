import { encryptCredential, decryptCredential, maskSecret } from './credential-encryption.util';

const ORIGINAL_ENV = process.env;

describe('credential-encryption.util', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' };
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('encryptCredential / decryptCredential', () => {
    it('round-trips a plaintext secret', () => {
      const plaintext = 'sk_live_super_secret_api_key';
      const encrypted = encryptCredential(plaintext, 'INTEGRATIONS');
      expect(decryptCredential(encrypted, 'INTEGRATIONS')).toBe(plaintext);
    });

    it('round-trips an empty string and unicode content', () => {
      expect(decryptCredential(encryptCredential('', 'INTEGRATIONS'), 'INTEGRATIONS')).toBe('');
      const unicode = '{"merchantId":"شركة-تجريبية-٥٥٥"}';
      expect(decryptCredential(encryptCredential(unicode, 'INTEGRATIONS'), 'INTEGRATIONS')).toBe(unicode);
    });

    it('never produces the same ciphertext twice for the same plaintext (random IV per call)', () => {
      const plaintext = 'sk_live_super_secret_api_key';
      const first = encryptCredential(plaintext, 'INTEGRATIONS');
      const second = encryptCredential(plaintext, 'INTEGRATIONS');
      expect(first).not.toBe(second);
      expect(decryptCredential(first, 'INTEGRATIONS')).toBe(plaintext);
      expect(decryptCredential(second, 'INTEGRATIONS')).toBe(plaintext);
    });

    it('stores the ciphertext as iv:authTag:ciphertext, all base64', () => {
      const encrypted = encryptCredential('secret', 'INTEGRATIONS');
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      for (const part of parts) {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      }
    });

    it('rejects a tampered ciphertext (auth tag mismatch)', () => {
      const encrypted = encryptCredential('secret', 'INTEGRATIONS');
      const [iv, authTag, ciphertext] = encrypted.split(':');
      const tamperedByte = Buffer.from(ciphertext, 'base64');
      tamperedByte[0] = tamperedByte[0] ^ 0xff;
      const tampered = `${iv}:${authTag}:${tamperedByte.toString('base64')}`;
      expect(() => decryptCredential(tampered, 'INTEGRATIONS')).toThrow();
    });

    it('rejects a malformed payload missing a segment', () => {
      expect(() => decryptCredential('only-one-segment', 'INTEGRATIONS')).toThrow('Malformed encrypted credential payload.');
      expect(() => decryptCredential('two:segments', 'INTEGRATIONS')).toThrow('Malformed encrypted credential payload.');
    });

    it('throws instead of silently encrypting when the key env var is unset', () => {
      delete process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY;
      expect(() => encryptCredential('secret', 'INTEGRATIONS')).toThrow(
        'INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY is not set',
      );
    });

    it('cannot decrypt a value encrypted under a different key', () => {
      const encrypted = encryptCredential('secret', 'INTEGRATIONS');
      process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = 'a-completely-different-key';
      expect(() => decryptCredential(encrypted, 'INTEGRATIONS')).toThrow();
    });
  });

  describe('maskSecret', () => {
    it('shows only the last 4 characters of a normal secret', () => {
      expect(maskSecret('sk_live_1234567890abcd')).toBe('••••abcd');
    });

    it('fully masks a secret that is 4 characters or shorter', () => {
      expect(maskSecret('abcd')).toBe('••••');
      expect(maskSecret('ab')).toBe('••••');
      expect(maskSecret('')).toBe('••••');
    });
  });
});
