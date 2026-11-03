/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import * as fs from 'fs';
import * as path from 'path';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthVisualService } from '../common/auth-visual.service';
import { GuestSessionService } from './guest-session.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { assertPortalOrigin, setRefreshCookie } from './portal-cookie.util';
import { SellerAccountDeletionService } from '../account-deletion/seller-account-deletion.service';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5G.1: portal cookie sessions (HttpOnly rotating refresh, reuse detection, CSRF) — real Nest controller over HTTP, real Mongo, real JWT. */
jest.setTimeout(120_000);
const PORTAL = 'https://account.example.test';
let h: MongoHarness;
let app: any;
let svc: AuthService;
const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '7d' } });
const redisStore: Record<string, string> = {};
const redis: any = { set: async (k: string, v: string) => { redisStore[k] = v; }, del: async (k: string) => { delete redisStore[k]; }, isConnected: false };
const stub: any = new Proxy({}, { get: () => jest.fn(async () => undefined) });
const sent: string[] = [];

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  process.env.PORTAL_ORIGINS = PORTAL;
  h = await startMongoHarness();
  svc = new AuthService({ repositories: h.repos } as any, { sendOtp: jest.fn(async (_to: string, otp: string) => { sent.push(otp); }) } as any, redis, stub, jwt);
  const mod = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: svc },
      { provide: AuthVisualService, useValue: {} },
      { provide: GuestSessionService, useValue: { mergeFromAuthResult: jest.fn() } },
    ],
  }).overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
    .overrideGuard(PermissionsGuard).useValue({ canActivate: () => true }).compile();
  app = mod.createNestApplication();
  app.use(cookieParser());
  await app.init();
});
afterAll(async () => { await app?.close(); await h?.stop(); });
beforeEach(async () => { await h.reset(); delete process.env.AUTH_COOKIE_DOMAIN; });

const http = () => request(app.getHttpServer());
const cookiesOf = (res: any): string[] => ([] as string[]).concat(res.headers['set-cookie'] ?? []);
const cookieLine = (res: any, name: string) => cookiesOf(res).find((c) => c.startsWith(`${name}=`));
const cookieVal = (res: any, name: string) => cookieLine(res, name)?.split(';')[0].slice(name.length + 1);

async function seedSeller(o: any = {}) {
  const _id = new Types.ObjectId();
  await h.repos.sellerModel.collection.insertOne({ _id, name: 'Olive', email: `o-${_id}@x.com`, role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, isVerified: true, password: await bcrypt.hash('pw-12345', 4), ...o });
  return { id: String(_id), email: o.email ?? `o-${_id}@x.com` };
}
/** Step 1 of every cookie flow. */
async function csrf() {
  const res = await http().get('/api/auth/csrf').set('Origin', PORTAL).expect(200);
  return { token: res.body.data.csrfToken as string, cookie: `solvexo_csrf=${cookieVal(res, 'solvexo_csrf')}` };
}
const loginOk = async (email: string): Promise<any> => {
  const k = await csrf();
  return http().post('/api/auth/login').set('Origin', PORTAL).set('X-Auth-Mode', 'cookie').set('X-CSRF-Token', k.token).set('Cookie', k.cookie).send({ email, password: 'pw-12345', role: 'seller' }).expect(201);
};
const cookieRefresh = (rt: string, k: { token: string; cookie: string }) =>
  http().post('/api/auth/refresh').set('Origin', PORTAL).set('X-Auth-Mode', 'cookie').set('X-CSRF-Token', k.token).set('Cookie', `${k.cookie}; solvexo_rt=${rt}`);

describe('GET /api/auth/csrf', () => {
  it('refuses a missing or foreign Origin, serves the portal with a signed HttpOnly cookie + the token in the body', async () => {
    const a = await http().get('/api/auth/csrf').expect(403);
    expect(a.body.code).toBe('CSRF_ORIGIN');
    const b = await http().get('/api/auth/csrf').set('Origin', 'https://evil.example').expect(403);
    expect(b.body.code).toBe('CSRF_ORIGIN');
    const ok = await http().get('/api/auth/csrf').set('Origin', PORTAL).expect(200);
    expect(ok.body.data.csrfToken).toEqual(expect.any(String));
    const line = cookieLine(ok, 'solvexo_csrf')!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\/api\/auth(;|$)/);
    expect(ok.headers['cache-control']).toBe('no-store');
  });
  it('falls back to the Referer origin when Origin is absent', () => {
    expect(() => assertPortalOrigin({ headers: { referer: `${PORTAL}/signin` } })).not.toThrow();
    expect(() => assertPortalOrigin({ headers: { referer: 'https://evil.example/x' } })).toThrow();
    expect(() => assertPortalOrigin({ headers: {} })).toThrow();
  });
});

describe('cookie-mode login', () => {
  it('sets the refresh token ONLY in an HttpOnly SameSite=Lax cookie limited to the refresh path; body has the access token + a CSRF token and NO refresh token', async () => {
    const s = await seedSeller();
    const res = await loginOk(s.email);
    expect(res.body.data.token.accessToken).toEqual(expect.any(String));
    expect(res.body.data.token.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(cookieVal(res, 'solvexo_rt')!);
    expect(res.body.data.csrfToken).toEqual(expect.any(String));
    const line = cookieLine(res, 'solvexo_rt')!;
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\/api\/auth\/refresh(;|$)/);
    expect(line).toMatch(/Max-Age=604800/);
    expect(line).not.toMatch(/Secure/i); // plain-http localhost in a non-production process
    const claims: any = jwt.verify(cookieVal(res, 'solvexo_rt')!);
    expect(claims).toMatchObject({ typ: 'refresh', role: 'seller', sub: s.id });
    expect(claims.fam).toBeDefined();
    expect(await h.repos.refreshTokenFamilyModel.countDocuments({ userId: s.id })).toBe(1);
  });

  it('Secure in production, Domain from AUTH_COOKIE_DOMAIN', () => {
    const calls: any[] = [];
    const res: any = { cookie: (...a: any[]) => calls.push(a) };
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; process.env.AUTH_COOKIE_DOMAIN = '.solvexo.store';
    setRefreshCookie({ headers: { host: 'api.solvexo.store' }, protocol: 'https' }, res, 'tok');
    process.env.NODE_ENV = prev; delete process.env.AUTH_COOKIE_DOMAIN;
    expect(calls[0][2]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/api/auth/refresh', maxAge: 604800000, domain: '.solvexo.store' });
    // localhost over http in dev is the only non-Secure case
    const dev: any[] = [];
    setRefreshCookie({ headers: { host: 'localhost:3002' }, protocol: 'http' }, { cookie: (...a: any[]) => dev.push(a) }, 'tok');
    expect(dev[0][2].secure).toBe(false);
  });

  it('rejects without the CSRF header, with a foreign origin, and with a forged/tampered cookie — before touching credentials', async () => {
    const s = await seedSeller();
    const k = await csrf();
    const base = () => http().post('/api/auth/login').set('X-Auth-Mode', 'cookie').send({ email: s.email, password: 'pw-12345', role: 'seller' });
    expect((await base().set('Origin', PORTAL).set('Cookie', k.cookie).expect(403)).body.code).toBe('CSRF_TOKEN');
    expect((await base().set('Origin', 'https://evil.example').set('X-CSRF-Token', k.token).set('Cookie', k.cookie).expect(403)).body.code).toBe('CSRF_ORIGIN');
    expect((await base().set('X-CSRF-Token', k.token).set('Cookie', k.cookie).expect(403)).body.code).toBe('CSRF_ORIGIN'); // no origin at all
    expect((await base().set('Origin', PORTAL).set('X-CSRF-Token', 'other').set('Cookie', k.cookie).expect(403)).body.code).toBe('CSRF_TOKEN');
    const forged = `solvexo_csrf=${k.token}.${Buffer.from('not-the-hmac').toString('base64url')}`;
    expect((await base().set('Origin', PORTAL).set('X-CSRF-Token', k.token).set('Cookie', forged).expect(403)).body.code).toBe('CSRF_TOKEN');
    expect(await h.repos.refreshTokenFamilyModel.countDocuments({})).toBe(0);
  });

  it('is seller-only: another role is refused with COOKIE_MODE_UNSUPPORTED', async () => {
    const issued = jwt.sign({ sub: String(new Types.ObjectId()), role: 'user', tokenVersion: 0, typ: 'refresh' });
    await expect(svc.toCookieSession({ data: { token: { accessToken: 'a', refreshToken: issued } } })).rejects.toMatchObject({ response: { code: 'COOKIE_MODE_UNSUPPORTED' } });
  });
});

describe('mobile (body mode) is unchanged', () => {
  it('login returns the refresh token in the JSON body, sets no cookie, needs no CSRF, creates no family', async () => {
    const s = await seedSeller();
    const res = await http().post('/api/auth/login').send({ email: s.email, password: 'pw-12345', role: 'seller' }).expect(201);
    expect(res.body.data.token.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.csrfToken).toBeUndefined();
    expect(cookiesOf(res)).toHaveLength(0);
    expect(await h.repos.refreshTokenFamilyModel.countDocuments({})).toBe(0);
    // body refresh still rotates statelessly
    const r = await http().post('/api/auth/refresh').send({ refreshToken: res.body.data.token.refreshToken }).expect(200);
    expect(r.body.data.token.refreshToken).toEqual(expect.any(String));
    expect(cookiesOf(r)).toHaveLength(0);
  });
  it('a cookie-family refresh token cannot be used through the body route', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    await http().post('/api/auth/refresh').send({ refreshToken: cookieVal(login, 'solvexo_rt') }).expect(401);
  });
});

describe('cookie refresh: rotation, reuse detection, CSRF', () => {
  it('rotates on EVERY refresh (new cookie + new access token + a fresh CSRF token) and the new cookie works', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    const rt0 = cookieVal(login, 'solvexo_rt')!;
    const k = await csrf();
    const r1 = await cookieRefresh(rt0, k).expect(200);
    const rt1 = cookieVal(r1, 'solvexo_rt')!;
    expect(rt1).not.toBe(rt0);
    expect(r1.body.data.token.refreshToken).toBeUndefined();
    expect(r1.body.data.token.accessToken).toEqual(expect.any(String));
    expect(redisStore[r1.body.data.token.accessToken]).toBe(s.id);
    expect(r1.body.data.csrfToken).toEqual(expect.any(String));
    expect(cookieLine(r1, 'solvexo_csrf')).toBeDefined();
    const k2 = { token: r1.body.data.csrfToken, cookie: `solvexo_csrf=${cookieVal(r1, 'solvexo_csrf')}` };
    const r2 = await cookieRefresh(rt1, k2).expect(200);
    expect(cookieVal(r2, 'solvexo_rt')).not.toBe(rt1);
    expect(await h.repos.refreshTokenFamilyModel.countDocuments({ userId: s.id })).toBe(1); // same family throughout
  });

  it('REUSE of an already-rotated token revokes the WHOLE family (even the newest token) and clears the cookie', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    const rt0 = cookieVal(login, 'solvexo_rt')!;
    const k = await csrf();
    const r1 = await cookieRefresh(rt0, k).expect(200);
    const rt1 = cookieVal(r1, 'solvexo_rt')!;
    // age the rotation past the 2-tab grace window
    await h.repos.refreshTokenFamilyModel.updateOne({ userId: s.id }, { $set: { rotatedAt: new Date(Date.now() - 60_000) } });
    const reuse = await cookieRefresh(rt0, k).expect(401);
    expect(reuse.body.code).toBe('REFRESH_REUSE');
    expect(cookieLine(reuse, 'solvexo_rt')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await h.repos.refreshTokenFamilyModel.findOne({ userId: s.id }).lean() as any)).toMatchObject({ revokedReason: 'reuse' });
    await cookieRefresh(rt1, k).expect(401); // the legitimate newest token died with the family
  });

  it('two tabs refreshing at once: the loser gets a retryable REFRESH_IN_PROGRESS, nothing is revoked, the winner keeps working', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    const rt0 = cookieVal(login, 'solvexo_rt')!;
    const k = await csrf();
    const r1 = await cookieRefresh(rt0, k).expect(200);
    const lose = await cookieRefresh(rt0, k).expect(401);
    expect(lose.body.code).toBe('REFRESH_IN_PROGRESS');
    expect(cookiesOf(lose).find((c) => c.startsWith('solvexo_rt='))).toBeUndefined(); // the (possibly just-rotated) cookie is left alone
    expect((await h.repos.refreshTokenFamilyModel.findOne({ userId: s.id }).lean() as any).revokedAt).toBeNull();
    await cookieRefresh(cookieVal(r1, 'solvexo_rt')!, k).expect(200);
  });

  it('needs CSRF + a portal Origin, a cookie, and a real refresh token', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    const rt = cookieVal(login, 'solvexo_rt')!;
    const k = await csrf();
    const noToken = await http().post('/api/auth/refresh').set('Origin', PORTAL).set('X-Auth-Mode', 'cookie').set('Cookie', `${k.cookie}; solvexo_rt=${rt}`).expect(403);
    expect(noToken.body.code).toBe('CSRF_TOKEN');
    const foreign = await http().post('/api/auth/refresh').set('Origin', 'https://evil.example').set('X-Auth-Mode', 'cookie').set('X-CSRF-Token', k.token).set('Cookie', `${k.cookie}; solvexo_rt=${rt}`).expect(403);
    expect(foreign.body.code).toBe('CSRF_ORIGIN');
    await http().post('/api/auth/refresh').set('Origin', PORTAL).set('X-Auth-Mode', 'cookie').set('X-CSRF-Token', k.token).set('Cookie', k.cookie).expect(401); // no refresh cookie
    // an ACCESS token placed in the cookie is refused
    await cookieRefresh(login.body.data.token.accessToken, k).expect(401);
  });

  it.each([
    ['tokenVersion bump', async (id: string) => { await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $inc: { tokenVersion: 1 } }); }],
    ['suspension', async (id: string) => { await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { status: 'suspended' } }); }],
    ['pending_deletion', async (id: string) => { await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { status: 'pending_deletion' } }); }],
    ['soft delete', async (id: string) => { await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { isDelete: true } }); }],
  ])('is refused after %s and the cookie is cleared', async (_n, mutate) => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    await mutate(s.id);
    const k = await csrf();
    const res = await cookieRefresh(cookieVal(login, 'solvexo_rt')!, k).expect(401);
    expect(cookieLine(res, 'solvexo_rt')).toMatch(/Expires=Thu, 01 Jan 1970/);
  });
});

describe('sign-out and revocation events', () => {
  it('DELETE /api/auth/refresh (CSRF-protected) revokes the family and clears the cookie', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    const rt = cookieVal(login, 'solvexo_rt')!;
    const k = await csrf();
    await http().delete('/api/auth/refresh').set('Origin', PORTAL).set('Cookie', `${k.cookie}; solvexo_rt=${rt}`).expect(403); // no CSRF header
    const out = await http().delete('/api/auth/refresh').set('Origin', PORTAL).set('X-CSRF-Token', k.token).set('Cookie', `${k.cookie}; solvexo_rt=${rt}`).expect(200);
    expect(cookieLine(out, 'solvexo_rt')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await h.repos.refreshTokenFamilyModel.findOne({ userId: s.id }).lean() as any)).toMatchObject({ revokedReason: 'logout' });
    await cookieRefresh(rt, k).expect(401);
  });

  it('the existing logout also revokes the family when the cookie is sent along', async () => {
    const s = await seedSeller();
    const login = await loginOk(s.email);
    await http().post('/api/auth/logout').set('Authorization', `Bearer ${login.body.data.token.accessToken}`).set('Cookie', `solvexo_rt=${cookieVal(login, 'solvexo_rt')}`).expect(201);
    expect((await h.repos.refreshTokenFamilyModel.findOne({ userId: s.id }).lean() as any).revokedAt).not.toBeNull();
    expect(redisStore[login.body.data.token.accessToken]).toBeUndefined();
  });

  it('a password reset revokes every portal session of the account', async () => {
    const s = await seedSeller({ otp: '123456', otpExpiresAt: new Date(Date.now() + 60_000), otpAttempts: 0 });
    const login = await loginOk(s.email);
    await svc.resetPassword(s.email, 'seller', '123456', 'new-pass-1');
    const fam: any = await h.repos.refreshTokenFamilyModel.findOne({ userId: s.id }).lean();
    expect(fam.revokedReason).toBe('password_reset');
    await cookieRefresh(cookieVal(login, 'solvexo_rt')!, await csrf()).expect(401);
  });

  it('account-deletion REQUEST revokes the owner’s portal sessions', async () => {
    const st = await seedStore(h);
    await h.repos.sellerModel.collection.insertOne({ _id: new Types.ObjectId(st.sellerId), name: 'Olive', email: 'del@x.com', role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, isVerified: true, password: await bcrypt.hash('pw-12345', 4) });
    const login = await loginOk('del@x.com');
    await new SellerAccountDeletionService({ repositories: h.repos } as any).request(st.sellerId, 'pw-12345');
    expect((await h.repos.refreshTokenFamilyModel.findOne({ userId: st.sellerId }).lean() as any).revokedReason).toBe('account_deletion');
    await cookieRefresh(cookieVal(login, 'solvexo_rt')!, await csrf()).expect(401);
  });
});

describe('wiring', () => {
  it('CORS allows the X-CSRF-Token and X-Auth-Mode headers (main.ts)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    expect(src).toContain("'X-CSRF-Token'");
    expect(src).toContain("'X-Auth-Mode'");
  });
});
