import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { CustomerSocialLoginService } from './customer-social-login.service';

jest.mock('../auth/auth.service', () => ({ AuthService: class {} }));
jest.mock('../auth/guest-session.service', () => ({ GuestSessionService: class {} }));
jest.mock('../common/store-ownership.util', () => ({ verifyStoreOwnershipStrict: jest.fn().mockResolvedValue({ slug: 'shop', customDomains: [] }) }));
jest.mock('../common/credential-encryption.util', () => ({
  encryptCredential: (v: string) => `enc:${v}`,
  decryptCredential: (v: string) => v.replace(/^enc:/, ''),
  maskSecret: () => '••••1234',
}));

const STORE_ID = 'a'.repeat(24);
const GOOGLE_ID = '123-abc.apps.googleusercontent.com';

function makeService() {
  const integrationModel: any = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    updateOne: jest.fn().mockResolvedValue({}),
    deleteOne: jest.fn().mockResolvedValue({}),
  };
  const storeModel: any = { findOne: jest.fn().mockResolvedValue({ _id: STORE_ID, slug: 'shop', customDomains: [] }) };
  const db: any = { repositories: { storeIntegrationModel: integrationModel, storeModel } };
  const redis: any = { set: jest.fn(), get: jest.fn(), del: jest.fn(), getDel: jest.fn() };
  const auth: any = { finishSocialLogin: jest.fn().mockResolvedValue({ data: { token: { accessToken: 'a' }, user: { _id: 'u' } } }) };
  const guests: any = { mergeFromAuthResult: jest.fn() };
  return { service: new CustomerSocialLoginService(db, redis, auth, guests), integrationModel, storeModel, redis, auth };
}

function mockFetch(body: any, ok = true) {
  const fn = jest.fn().mockResolvedValue({ ok, json: async () => body });
  (global as any).fetch = fn;
  return fn;
}

describe('CustomerSocialLoginService', () => {
  const realFetch = (global as any).fetch;
  beforeAll(() => { process.env.JWT_SECRET = 'test-secret'; });
  afterEach(() => { (global as any).fetch = realFetch; });

  describe('connect (verify on save)', () => {
    it('rejects a Google Client ID with the wrong format without calling Google', async () => {
      const { service } = makeService();
      const f = mockFetch({});
      await expect(service.connect(STORE_ID, 's1', 'google', { clientId: 'nope', clientSecret: 'x' })).rejects.toThrow(/Google Client ID/);
      expect(f).not.toHaveBeenCalled();
    });

    it('rejects a non-numeric Facebook App ID', async () => {
      const { service } = makeService();
      await expect(service.connect(STORE_ID, 's1', 'facebook', { clientId: 'abc', clientSecret: 'x' })).rejects.toThrow(/Facebook App ID/);
    });

    it('does NOT save when Google answers invalid_client', async () => {
      const { service, integrationModel } = makeService();
      mockFetch({ error: 'invalid_client' }, false);
      await expect(service.connect(STORE_ID, 's1', 'google', { clientId: GOOGLE_ID, clientSecret: 'bad' })).rejects.toThrow(/rejected/);
      expect(integrationModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('saves when Google answers invalid_grant (credentials accepted, fake code rejected)', async () => {
      const { service, integrationModel } = makeService();
      mockFetch({ error: 'invalid_grant' }, false);
      await service.connect(STORE_ID, 's1', 'google', { clientId: GOOGLE_ID, clientSecret: 'good' });
      expect(integrationModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      const update = integrationModel.findOneAndUpdate.mock.calls[0][1].$set;
      expect(update.status).toBe('connected');
      expect(update.lastVerifiedAt).toBeInstanceOf(Date);
      expect(update.credentialsEncrypted).toContain('good');
    });

    it('does NOT save when Facebook gives no app token', async () => {
      const { service, integrationModel } = makeService();
      mockFetch({ error: { message: 'Invalid client secret' } }, false);
      await expect(service.connect(STORE_ID, 's1', 'facebook', { clientId: '1234567890', clientSecret: 'bad' })).rejects.toThrow(/Facebook rejected/);
      expect(integrationModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('saves when Facebook returns an app token', async () => {
      const { service, integrationModel } = makeService();
      mockFetch({ access_token: '1234567890|abc' });
      await service.connect(STORE_ID, 's1', 'facebook', { clientId: '1234567890', clientSecret: 'good' });
      expect(integrationModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('reports a network failure as a retryable message and saves nothing', async () => {
      const { service, integrationModel } = makeService();
      (global as any).fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
      await expect(service.connect(STORE_ID, 's1', 'google', { clientId: GOOGLE_ID, clientSecret: 'x' })).rejects.toThrow(/Could not reach Google/);
      expect(integrationModel.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('test connection', () => {
    it('records lastError when the provider rejects the saved credentials', async () => {
      const { service, integrationModel } = makeService();
      integrationModel.findOne.mockResolvedValue({ credentialsEncrypted: `enc:${JSON.stringify({ clientId: GOOGLE_ID, clientSecret: 'old' })}` });
      mockFetch({ error: 'invalid_client' }, false);
      const out = await service.test(STORE_ID, 's1', 'google');
      expect(out.ok).toBe(false);
      expect(integrationModel.updateOne.mock.calls[0][1].$set.lastError).toMatch(/rejected/);
    });

    it('clears lastError and stamps lastVerifiedAt when accepted', async () => {
      const { service, integrationModel } = makeService();
      integrationModel.findOne.mockResolvedValue({ credentialsEncrypted: `enc:${JSON.stringify({ clientId: GOOGLE_ID, clientSecret: 'ok' })}` });
      mockFetch({ error: 'invalid_grant' }, false);
      const out = await service.test(STORE_ID, 's1', 'google');
      expect(out.ok).toBe(true);
      const set = integrationModel.updateOne.mock.calls[0][1].$set;
      expect(set.lastError).toBeNull();
      expect(set.lastVerifiedAt).toBeInstanceOf(Date);
    });
  });

  describe('exchange (one-time code)', () => {
    const code = 'a'.repeat(48);
    it('uses an atomic read-and-delete and returns the stored session', async () => {
      const { service, redis } = makeService();
      redis.getDel.mockResolvedValue(JSON.stringify({ token: { accessToken: 't' } }));
      const out = await service.exchange(code);
      expect(redis.getDel).toHaveBeenCalledWith(`social-exchange:${code}`);
      expect(out.data.token.accessToken).toBe('t');
    });

    it('rejects a replayed / unknown code', async () => {
      const { service, redis } = makeService();
      redis.getDel.mockResolvedValue(null);
      await expect(service.exchange(code)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a malformed code before touching Redis', async () => {
      const { service, redis } = makeService();
      await expect(service.exchange('short')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(redis.getDel).not.toHaveBeenCalled();
    });
  });

  describe('buildAuthUrl / callback state', () => {
    function creds(integrationModel: any) {
      integrationModel.findOne.mockResolvedValue({ credentialsEncrypted: `enc:${JSON.stringify({ clientId: GOOGLE_ID, clientSecret: 's' })}` });
    }

    it('refuses a return address that is not one of the store\'s own', async () => {
      const { service, integrationModel } = makeService();
      creds(integrationModel);
      await expect(service.buildAuthUrl(STORE_ID, 'google', 'https://evil.example')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('startRedirect sends the buyer back to the store login with a message when the method is off', async () => {
      const { service, integrationModel } = makeService();
      integrationModel.findOne.mockResolvedValue(null);
      const url = await service.startRedirect(STORE_ID, 'google', 'https://shop.solvexo.store');
      expect(url).toMatch(/^https:\/\/shop\.solvexo\.store\/login\?social_error=/);
    });

    it('startRedirect still throws for an untrusted return address (no open redirect)', async () => {
      const { service, integrationModel } = makeService();
      integrationModel.findOne.mockResolvedValue(null);
      await expect(service.startRedirect(STORE_ID, 'google', 'https://evil.example')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a tampered state goes to the store\'s own login page, never an attacker address', async () => {
      const { service } = makeService();
      const out = await service.handleCallback('google', STORE_ID, 'code', 'forged.state');
      expect(out.redirectTo).toMatch(/^https:\/\/shop\.solvexo\.store\/login\?social_error=/);
    });

    it('rejects a Google id_token that is expired, from the wrong issuer or for another client', async () => {
      const { service, integrationModel } = makeService();
      creds(integrationModel);
      const url = await service.buildAuthUrl(STORE_ID, 'google', 'https://shop.solvexo.store');
      const state = new URL(url).searchParams.get('state') as string;
      const idToken = (claims: any) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
      const good = { aud: GOOGLE_ID, sub: '1', iss: 'https://accounts.google.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'a@b.com', email_verified: true };

      for (const bad of [{ ...good, exp: 1 }, { ...good, iss: 'https://evil.example' }, { ...good, aud: 'other' }]) {
        mockFetch({ id_token: idToken(bad) });
        const out = await service.handleCallback('google', STORE_ID, 'code', state);
        expect(out.redirectTo).toContain('social_error=');
      }
    });

    it('signs the buyer in with a verified Google identity and returns a one-time code', async () => {
      const { service, integrationModel, redis, auth } = makeService();
      creds(integrationModel);
      const url = await service.buildAuthUrl(STORE_ID, 'google', 'https://shop.solvexo.store');
      const state = new URL(url).searchParams.get('state') as string;
      const claims = { aud: GOOGLE_ID, sub: 'g-1', iss: 'accounts.google.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'Buyer@Mail.com', email_verified: true, name: 'Buyer' };
      mockFetch({ id_token: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s` });
      const out = await service.handleCallback('google', STORE_ID, 'code', state);
      expect(out.redirectTo).toMatch(/^https:\/\/shop\.solvexo\.store\/login\?social_code=[a-f0-9]{48}$/);
      expect(auth.finishSocialLogin).toHaveBeenCalledWith(expect.objectContaining({ email: 'buyer@mail.com', storeId: STORE_ID }), 'buyer@mail.com');
      expect(redis.set).toHaveBeenCalled();
    });

    it('does not trust an unverified Google email', async () => {
      const { service, integrationModel, auth } = makeService();
      creds(integrationModel);
      const url = await service.buildAuthUrl(STORE_ID, 'google', 'https://shop.solvexo.store');
      const state = new URL(url).searchParams.get('state') as string;
      const claims = { aud: GOOGLE_ID, sub: 'g-1', iss: 'accounts.google.com', exp: Math.floor(Date.now() / 1000) + 600, email: 'x@y.com', email_verified: false };
      mockFetch({ id_token: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s` });
      const out = await service.handleCallback('google', STORE_ID, 'code', state);
      expect(out.redirectTo).toContain('social_error=');
      expect(auth.finishSocialLogin).not.toHaveBeenCalled();
    });
  });
});
