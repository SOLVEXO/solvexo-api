/* eslint-disable prettier/prettier */
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { AuthService } from './auth.service';
import { parsePortalOrigins } from '../common/portal-origins.util';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5F.1: refresh tokens + Sign in with Apple, against a REAL Mongo and real JWT signing. */
jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '7d' } });
const redisStore: Record<string, string> = {};
const redis: any = { set: async (k: string, v: string) => { redisStore[k] = v; }, isConnected: false };
const stub: any = new Proxy({}, { get: () => jest.fn(async () => undefined) });
let appleToken: any = null;
let appleAudiences: string[] = [];
class TestAuth extends AuthService {
  protected async verifyAppleIdToken(_t: string, audiences: string[]) { appleAudiences = audiences; return appleToken; }
}
const auth = () => new TestAuth({ repositories: h.repos } as any, { sendOtp: jest.fn() } as any, redis, stub, jwt);

async function seedSeller(o: any = {}) {
  const _id = new Types.ObjectId();
  await h.repos.sellerModel.collection.insertOne({ _id, name: 'Olive', email: `o-${_id}@x.com`, role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, isVerified: true, ...o });
  return String(_id);
}
const claims = (id: string, extra: any = {}) => ({ sub: id, email: 'o@x.com', role: 'seller', tokenVersion: 0, ...extra });

describe('POST /api/auth/refresh (service)', () => {
  it('exchanges a refresh token for a new access token (stored in Redis) and a rotated refresh token', async () => {
    const id = await seedSeller();
    const rt = jwt.sign({ ...claims(id), typ: 'refresh' });
    const res: any = await auth().refresh(rt);
    expect(res.success).toBe(true);
    const { accessToken, refreshToken } = res.data.token;
    expect(redisStore[accessToken]).toBe(id);
    expect(jwt.verify(accessToken).typ).toBeUndefined();
    expect(jwt.verify(refreshToken)).toMatchObject({ typ: 'refresh', sub: id, role: 'seller' });
    // the new refresh token works again
    await expect(auth().refresh(refreshToken)).resolves.toMatchObject({ success: true });
  });

  it('login/social-login/verify issue refresh tokens that carry typ:refresh', async () => {
    const id = await seedSeller({ email: 'real@x.com', providerId: 'g1', authProvider: 'google' });
    const svc: any = auth();
    const session = await svc.issueLoginSession(await h.repos.sellerModel.findById(id), 'seller');
    expect(jwt.verify(session.data.token.refreshToken).typ).toBe('refresh');
    expect(jwt.verify(session.data.token.accessToken).typ).toBeUndefined();
  });

  it('refuses an ACCESS token (no typ), garbage, and legacy refresh tokens without typ', async () => {
    const id = await seedSeller();
    await expect(auth().refresh(jwt.sign(claims(id)))).rejects.toThrow('Invalid refresh token');
    await expect(auth().refresh('not.a.jwt')).rejects.toThrow('Invalid refresh token');
    await expect(auth().refresh(jwt.sign({ ...claims(id), typ: 'refresh', type: 'pos_device' }))).rejects.toThrow();
  });

  it('is revoked by a tokenVersion bump', async () => {
    const id = await seedSeller();
    const rt = jwt.sign({ ...claims(id), typ: 'refresh' });
    await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $inc: { tokenVersion: 1 } });
    await expect(auth().refresh(rt)).rejects.toThrow('Session expired');
  });

  it.each(['suspended', 'deleted', 'pending_deletion'])('is refused for a %s account', async (status) => {
    const id = await seedSeller({ status });
    await expect(auth().refresh(jwt.sign({ ...claims(id), typ: 'refresh' }))).rejects.toThrow('Session expired');
  });

  it('is refused for a soft-deleted or unknown account', async () => {
    const id = await seedSeller({ isDelete: true });
    await expect(auth().refresh(jwt.sign({ ...claims(id), typ: 'refresh' }))).rejects.toThrow();
    await expect(auth().refresh(jwt.sign({ ...claims(String(new Types.ObjectId())), typ: 'refresh' }))).rejects.toThrow();
  });
});

describe('Sign in with Apple', () => {
  const dto = (o: any = {}) => ({ authProvider: 'apple', socialId: 'apple-sub-1', token: 'idtoken', role: 'seller', ...o });

  it('passes every comma-separated APPLE_CLIENT_ID as an accepted audience', async () => {
    process.env.APPLE_CLIENT_ID = 'com.solvexo.app, com.solvexo.web';
    appleToken = { sub: 'apple-sub-1', email: 'a@x.com', email_verified: 'true' };
    await auth().socialLogin(dto() as any);
    expect(appleAudiences).toEqual(['com.solvexo.app', 'com.solvexo.web']);
  });

  it('works without a client-sent email and creates the account from the verified token email', async () => {
    appleToken = { sub: 'apple-sub-1', email: 'New@X.com', email_verified: true };
    const res: any = await auth().socialLogin(dto() as any);
    expect(res.success).toBe(true);
    const sel: any = await h.repos.sellerModel.collection.findOne({ email: 'new@x.com' });
    expect(sel).toMatchObject({ authProvider: 'apple', providerId: 'apple-sub-1' });
  });

  it('links to the existing account with the same VERIFIED email (same rule as Google)', async () => {
    const id = await seedSeller({ email: 'same@x.com', password: 'hash' });
    appleToken = { sub: 'apple-sub-1', email: 'same@x.com', email_verified: 'true' };
    const res: any = await auth().socialLogin(dto() as any);
    expect(res.data.user.id.toString()).toBe(id);
    expect(await h.repos.sellerModel.countDocuments({})).toBe(1);
    expect((await h.repos.sellerModel.collection.findOne({ _id: new Types.ObjectId(id) }) as any)).toMatchObject({ providerId: 'apple-sub-1', authProvider: 'apple' });
  });

  it('does NOT link by email when the token does not say email_verified (no account is taken over)', async () => {
    const id = await seedSeller({ email: 'victim@x.com', password: 'hash' });
    appleToken = { sub: 'attacker-sub', email: 'victim@x.com', email_verified: false };
    // 5G.1: the sign-in itself succeeds (Apple accounts are keyed by `sub`) but as its OWN account — never the victim's.
    const res: any = await auth().socialLogin(dto({ socialId: 'attacker-sub' }) as any);
    expect(res.data.user.id.toString()).not.toBe(id);
    expect((await h.repos.sellerModel.collection.findOne({ _id: new Types.ObjectId(id) }) as any).providerId).toBeUndefined();
    expect(await h.repos.sellerModel.countDocuments({})).toBe(2);
  });

  it('later sign-ins with no email in the token and no client email still resolve by provider id', async () => {
    const id = await seedSeller({ email: 'acct@x.com', providerId: 'apple-sub-1', authProvider: 'apple' });
    appleToken = { sub: 'apple-sub-1' };
    const res: any = await auth().socialLogin(dto() as any);
    expect(res.data.user.id.toString()).toBe(id);
  });

  it('refuses a token whose sub is not the claimed socialId', async () => {
    appleToken = { sub: 'someone-else', email: 'a@x.com', email_verified: true };
    await expect(auth().socialLogin(dto() as any)).rejects.toThrow('Invalid Apple token');
  });
});

describe('PORTAL_ORIGINS parsing', () => {
  it('keeps exact https origins (and localhost http), drops wildcards, paths and plain http', () => {
    expect(parsePortalOrigins('https://account.solvexo.store, http://localhost:5173,https://*.vercel.app,http://evil.com,https://x.com/path,junk,')).toEqual(['https://account.solvexo.store', 'http://localhost:5173']);
    expect(parsePortalOrigins(undefined)).toEqual([]);
  });
});
