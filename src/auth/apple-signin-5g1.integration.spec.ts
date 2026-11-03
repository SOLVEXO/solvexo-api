/* eslint-disable prettier/prettier */
import { generateKeyPairSync, createVerify } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { AuthService } from './auth.service';
import { AppleAuthClient, AppleTokenService, buildAppleClientSecret, decryptAppleToken, encryptAppleToken } from './apple-token.service';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5G.1: Sign in with Apple keyed by `sub` (Hide My Email, no-email, linking rules) + authorization-code token storage. REAL Mongo. */
jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '7d' } });
const redis: any = { set: async () => undefined, isConnected: false };
const stub: any = new Proxy({}, { get: () => jest.fn(async () => undefined) });
let appleToken: any = null;
class TestAuth extends AuthService {
  protected async verifyAppleIdToken() { return appleToken; }
}
class FakeApple extends AppleAuthClient {
  codes: { code: string; clientId: string }[] = [];
  revoked: { token: string; clientId: string }[] = [];
  failExchange = false;
  failRevoke = false;
  async exchangeCode(code: string, clientId: string) { if (this.failExchange) throw new Error('apple down'); this.codes.push({ code, clientId }); return 'apple-refresh-token-PLAINTEXT'; }
  async revoke(token: string, clientId: string) { if (this.failRevoke) throw new Error('apple 400 invalid_request'); this.revoked.push({ token, clientId }); }
}
const otp = { sendOtp: jest.fn() };
const make = (client = new FakeApple()) => {
  const tokens = new AppleTokenService({ repositories: h.repos } as any, client);
  return { client, tokens, auth: new TestAuth({ repositories: h.repos } as any, otp as any, redis, stub, jwt, undefined, undefined, undefined, tokens) };
};
const dto = (o: any = {}) => ({ authProvider: 'apple', socialId: 'apple-sub-1', token: 'idtoken', role: 'seller', ...o });
async function seedSeller(o: any = {}) {
  const _id = new Types.ObjectId();
  await h.repos.sellerModel.collection.insertOne({ _id, name: 'Olive', email: `o-${_id}@x.com`, role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, isVerified: true, ...o });
  return String(_id);
}
const raw = async (id: string): Promise<any> => h.repos.sellerModel.collection.findOne({ _id: new Types.ObjectId(id) });

describe('accounts are keyed by Apple `sub`', () => {
  it('a brand-new Hide-My-Email user signs up; the relay email from the FIRST authorization is stored', async () => {
    appleToken = { sub: 'apple-sub-1', email: 'abc123@privaterelay.appleid.com', email_verified: 'true', aud: 'com.solvexo.solvexoPos' };
    const res: any = await make().auth.socialLogin(dto({ email: 'abc123@privaterelay.appleid.com' }) as any);
    expect(res.success).toBe(true);
    const s = await raw(String(res.data.user.id));
    expect(s).toMatchObject({ email: 'abc123@privaterelay.appleid.com', authProvider: 'apple', providerId: 'apple-sub-1', role: 'seller' });
    expect(s.emailIsPlaceholder).not.toBe(true);
  });

  it('a later login whose token has NO email claim (and no client email) resolves by `sub`, keeping the stored relay email', async () => {
    appleToken = { sub: 'apple-sub-1', email: 'abc123@privaterelay.appleid.com', email_verified: true };
    const first: any = await make().auth.socialLogin(dto() as any);
    appleToken = { sub: 'apple-sub-1' };
    const again: any = await make().auth.socialLogin(dto() as any);
    expect(again.data.user.id.toString()).toBe(first.data.user.id.toString());
    expect(again.data.user.email).toBe('abc123@privaterelay.appleid.com');
    expect(await h.repos.sellerModel.countDocuments({})).toBe(1);
  });

  it('a brand-new user with NO email anywhere still signs up, with a unique non-deliverable placeholder (flagged)', async () => {
    appleToken = { sub: 'Sub.One' };
    const a: any = await make().auth.socialLogin(dto({ socialId: 'Sub.One' }) as any);
    appleToken = { sub: 'sub-two' };
    const b: any = await make().auth.socialLogin(dto({ socialId: 'sub-two' }) as any);
    const sa = await raw(String(a.data.user.id)); const sb = await raw(String(b.data.user.id));
    expect(sa).toMatchObject({ email: 'apple+sub.one@apple-signin.invalid', emailIsPlaceholder: true });
    expect(sb.email).toBe('apple+sub-two@apple-signin.invalid');
    // and signing in again by sub lands on the same account
    appleToken = { sub: 'Sub.One' };
    expect(((await make().auth.socialLogin(dto({ socialId: 'Sub.One' }) as any)) as any).data.user.id.toString()).toBe(String(a.data.user.id));
  });

  it('no mail path ever goes to a placeholder: OTP/forgot-password refuse it, EmailService skips .invalid', async () => {
    appleToken = { sub: 'sub-x' };
    await make().auth.socialLogin(dto({ socialId: 'sub-x' }) as any);
    otp.sendOtp.mockClear();
    await expect(make().auth.forgotPassword('apple+sub-x@apple-signin.invalid', 'seller')).rejects.toThrow(/no deliverable email/i);
    expect(otp.sendOtp).not.toHaveBeenCalled();
    const { EmailService } = await import('../otp/services/email.service');
    const es: any = Object.create(EmailService.prototype);
    es.transporter = { sendMail: jest.fn() };
    expect(await es.sendMail('deleted+1@deleted.invalid', 's', '<p>x</p>')).toBe(false);
    expect(es.transporter.sendMail).not.toHaveBeenCalled();
  });

  it('links to an existing PASSWORD account only through a VERIFIED matching email', async () => {
    const id = await seedSeller({ email: 'same@x.com', password: 'hash' });
    appleToken = { sub: 'apple-sub-1', email: 'Same@X.com', email_verified: 'true' };
    const res: any = await make().auth.socialLogin(dto() as any);
    expect(res.data.user.id.toString()).toBe(id);
    expect(await h.repos.sellerModel.countDocuments({})).toBe(1);
    expect(await raw(id)).toMatchObject({ providerId: 'apple-sub-1', authProvider: 'apple' });
  });

  it('an UNVERIFIED email never links — even when the client claims it — and the sign-up falls back to a placeholder instead of colliding', async () => {
    const id = await seedSeller({ email: 'victim@x.com', password: 'hash' });
    appleToken = { sub: 'attacker', email: 'victim@x.com', email_verified: false };
    const res: any = await make().auth.socialLogin(dto({ socialId: 'attacker', email: 'victim@x.com' }) as any);
    expect(res.data.user.id.toString()).not.toBe(id);
    expect((await raw(String(res.data.user.id)))).toMatchObject({ emailIsPlaceholder: true, providerId: 'attacker' });
    expect((await raw(id)).providerId).toBeUndefined();
    expect(await h.repos.sellerModel.countDocuments({})).toBe(2);
  });

  it('non-Apple providers keep the old rule (no email and no existing account → refused)', async () => {
    const { auth } = make();
    (auth as any).verifySocialToken = async () => null;
    await expect(auth.socialLogin({ authProvider: 'google', socialId: 'g1', token: 't', role: 'seller' } as any)).rejects.toThrow(/No email available/);
  });
});

describe('Apple authorization code → encrypted refresh token at rest', () => {
  beforeEach(() => {
    process.env.APPLE_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    process.env.APPLE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.APPLE_KEY_ID = 'KEY123'; process.env.APPLE_TEAM_ID = 'TEAM123';
  });

  it('stores the exchanged token ENCRYPTED (never plaintext), with the client id for the revoke call; selected only on request', async () => {
    appleToken = { sub: 'apple-sub-1', email: 'a@x.com', email_verified: true, aud: 'com.solvexo.account.web' };
    const { auth, client } = make();
    const res: any = await auth.socialLogin(dto({ authorizationCode: 'code-1' }) as any);
    expect(client.codes).toEqual([{ code: 'code-1', clientId: 'com.solvexo.account.web' }]);
    const s = await raw(String(res.data.user.id));
    expect(s.appleRefreshTokenEnc).toMatch(/^v1:/);
    expect(s.appleRefreshTokenEnc).not.toContain('PLAINTEXT');
    expect(decryptAppleToken(s.appleRefreshTokenEnc)).toBe('apple-refresh-token-PLAINTEXT');
    expect(s.appleClientId).toBe('com.solvexo.account.web');
    // never leaks through a normal read (profile endpoints) nor in the login response
    const normal: any = await h.repos.sellerModel.findById(res.data.user.id).lean();
    expect(normal.appleRefreshTokenEnc).toBeUndefined();
    expect(JSON.stringify(res)).not.toMatch(/PLAINTEXT|v1:/);
  });

  it('an exchange failure, a missing code or missing config never fails the login', async () => {
    appleToken = { sub: 'apple-sub-1', email: 'a@x.com', email_verified: true, aud: 'a' };
    const failing = new FakeApple(); failing.failExchange = true;
    const r1: any = await make(failing).auth.socialLogin(dto({ authorizationCode: 'c' }) as any);
    expect(r1.success).toBe(true);
    expect((await raw(String(r1.data.user.id))).appleRefreshTokenEnc ?? null).toBeNull();
    const ok = make();
    await ok.auth.socialLogin(dto() as any); // no code
    expect(ok.client.codes).toHaveLength(0);
    delete process.env.APPLE_PRIVATE_KEY;
    await ok.auth.socialLogin(dto({ authorizationCode: 'c' }) as any); // not configured
    expect(ok.client.codes).toHaveLength(0);
  });
});

describe('Apple crypto primitives', () => {
  beforeEach(() => { process.env.APPLE_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString('base64'); });
  it('AES-256-GCM round-trips with a random IV per call, and fails on tamper or the wrong key', () => {
    const a = encryptAppleToken('secret-token'); const b = encryptAppleToken('secret-token');
    expect(a).not.toBe(b);
    expect(decryptAppleToken(a)).toBe('secret-token');
    const parts = a.split('.'); parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptAppleToken(parts.join('.'))).toThrow();
    process.env.APPLE_TOKEN_ENC_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(() => decryptAppleToken(a)).toThrow();
    expect(() => decryptAppleToken('v9:x.y.z')).toThrow(/Unknown envelope/);
    process.env.APPLE_TOKEN_ENC_KEY = Buffer.alloc(16).toString('base64');
    expect(() => encryptAppleToken('x')).toThrow(/32 bytes/);
  });
  it('the client secret is an ES256 JWT with Apple’s claims, verifiable with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    process.env.APPLE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().replace(/\n/g, '\\n'); // single-line env form
    process.env.APPLE_KEY_ID = 'KEY123'; process.env.APPLE_TEAM_ID = 'TEAM123';
    const t = buildAppleClientSecret('com.solvexo.solvexoPos', 1_700_000_000);
    const [h64, p64, s64] = t.split('.');
    expect(JSON.parse(Buffer.from(h64, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p64, 'base64url').toString())).toEqual({ iss: 'TEAM123', iat: 1_700_000_000, exp: 1_700_000_300, aud: 'https://appleid.apple.com', sub: 'com.solvexo.solvexoPos' });
    const v = createVerify('sha256'); v.update(`${h64}.${p64}`);
    expect(v.verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url'))).toBe(true);
  });
});
