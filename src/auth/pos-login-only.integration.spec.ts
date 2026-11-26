/* eslint-disable prettier/prettier */
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { MongoHarness, startMongoHarness } from '../pos/testing/mongo-harness';

/** G6.5: the POS app is login-only. `X-Solvexo-Client: pos` makes Google/Apple sign-in refuse to create an account. REAL Mongo. */
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
const auth = () => {
  const a = new TestAuth({ repositories: h.repos } as any, { sendOtp: jest.fn() } as any, redis, stub, jwt);
  (a as any).googleClient = { verifyIdToken: async () => ({ getPayload: () => ({ sub: 'g-1', email: 'new@example.com', email_verified: true }) }) };
  return a;
};
const google = (o: any = {}) => ({ authProvider: 'google', socialId: 'g-1', token: 'idtoken', role: 'seller', name: 'New Owner', ...o });
const counts = async () => ({ sellers: await h.repos.sellerModel.countDocuments({}), users: await h.repos.userModel.countDocuments({}) });
async function seedSeller(o: any = {}) {
  const _id = new Types.ObjectId();
  await h.repos.sellerModel.collection.insertOne({ _id, name: 'Olive', email: 'new@example.com', role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, isVerified: true, ...o });
  return String(_id);
}
const controller = () => {
  const c = Object.create(AuthController.prototype) as any;
  c.authService = auth();
  c.guestSessions = { mergeFromAuthResult: jest.fn() };
  return c;
};
const req = (headers: any = {}) => ({ headers });

describe('POS (login-only) social sign-in', () => {
  it('unknown Google identity → ACCOUNT_NOT_FOUND and nothing is written', async () => {
    await expect(auth().socialLogin(google() as any, { loginOnly: true })).rejects.toMatchObject({
      status: 401,
      response: { code: 'ACCOUNT_NOT_FOUND' },
    });
    expect(await counts()).toEqual({ sellers: 0, users: 0 });
  });

  it('unknown Apple identity → ACCOUNT_NOT_FOUND and nothing is written', async () => {
    appleToken = { sub: 'apple-1', email: 'abc@privaterelay.appleid.com', email_verified: true };
    await expect(auth().socialLogin({ authProvider: 'apple', socialId: 'apple-1', token: 't', role: 'seller' } as any, { loginOnly: true })).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    expect(await counts()).toEqual({ sellers: 0, users: 0 });
  });

  it('existing seller → login works, no second account', async () => {
    const id = await seedSeller();
    const res: any = await auth().socialLogin(google() as any, { loginOnly: true });
    expect(res.success).toBe(true);
    expect(String(res.data.user.id)).toBe(id);
    expect(res.data.isNewUser).toBe(false);
    expect(await counts()).toEqual({ sellers: 1, users: 0 });
  });

  it('suspended existing seller is still refused with the suspension message', async () => {
    await seedSeller({ status: 'suspended' });
    await expect(auth().socialLogin(google() as any, { loginOnly: true })).rejects.toThrow(/suspended/);
  });
});

describe('other clients are unchanged', () => {
  it('service default (no option): an unknown Google identity still signs up', async () => {
    const res: any = await auth().socialLogin(google() as any);
    expect(res.success).toBe(true);
    expect(res.data.isNewUser).toBe(true);
    expect(await counts()).toEqual({ sellers: 1, users: 0 });
  });

  it('storefront buyer (no header, role user) still signs up', async () => {
    const res: any = await auth().socialLogin(google({ role: undefined }) as any);
    expect(res.success).toBe(true);
    expect(await counts()).toEqual({ sellers: 0, users: 1 });
  });
});

describe('controller: X-Solvexo-Client header', () => {
  it('header "pos" → login-only (no account created)', async () => {
    await expect(controller().socialLogin(req({ 'x-solvexo-client': 'pos' }), { cookie: jest.fn() }, google())).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    expect(await counts()).toEqual({ sellers: 0, users: 0 });
  });

  it('no header → unchanged sign-up behaviour', async () => {
    const res: any = await controller().socialLogin(req(), { cookie: jest.fn() }, google());
    expect(res.success).toBe(true);
    expect(await counts()).toEqual({ sellers: 1, users: 0 });
  });

  it('another client value → unchanged sign-up behaviour', async () => {
    const res: any = await controller().socialLogin(req({ 'x-solvexo-client': 'storefront' }), { cookie: jest.fn() }, google());
    expect(res.success).toBe(true);
  });
});
