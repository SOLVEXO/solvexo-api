/* eslint-disable prettier/prettier */
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { Types } from 'mongoose';
import { SellerAccountDeletionService, GENERIC_OTP_MESSAGE } from './seller-account-deletion.service';
import { PosTokenRevocationService } from '../pos/pos-token-revocation.service';
import { RedisService } from '../redis/redis.service';
import { AuthService } from '../auth/auth.service';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5F.1: deletion re-auth for social accounts + the signed-out OTP flow, against a REAL Mongo. */
jest.setTimeout(120_000);
let h: MongoHarness;
let redis: RedisService;
beforeAll(async () => { process.env.JWT_SECRET = 'test-secret'; h = await startMongoHarness(); redis = new RedisService(); await redis.onModuleInit(); });
afterAll(async () => { await redis?.onModuleDestroy(); await h?.stop(); });
beforeEach(async () => { await h.reset(); });

const sent: { to: string; otp: string }[] = [];
const otpService: any = { sendOtp: jest.fn(async (to: string, otp: string) => { sent.push({ to, otp }); }) };
const providerEmail: { v: string | null; fail: boolean } = { v: null, fail: false };
const auth: any = { verifyProviderIdentity: jest.fn(async () => { if (providerEmail.fail) throw new Error('bad token'); return providerEmail.v; }) };
const svc = () => new SellerAccountDeletionService({ repositories: h.repos } as any, new PosTokenRevocationService(redis), auth, otpService);

async function seedSeller(s: { sellerId: string }, o: { password?: string | null; providerId?: string | null; authProvider?: string | null; email?: string } = {}) {
  const password = o.password === undefined ? 'pw-12345' : o.password;
  await h.repos.sellerModel.collection.insertOne({ _id: new Types.ObjectId(s.sellerId), name: 'Olive', email: o.email ?? `olive-${s.sellerId}@x.com`, role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, password: password ? await bcrypt.hash(password, 4) : null, providerId: o.providerId === undefined ? 'g-123' : o.providerId, authProvider: o.authProvider === undefined ? 'google' : o.authProvider });
}
const seller = async (id: string): Promise<any> => h.repos.sellerModel.collection.findOne({ _id: new Types.ObjectId(id) });

describe('status flags', () => {
  it('reports hasPassword + authProvider so the UI picks the re-auth method', async () => {
    const a = await seedStore(h); await seedSeller(a, { password: null });
    expect((await svc().status(a.sellerId) as any).data).toMatchObject({ hasPassword: false, authProvider: 'google' });
    const b = await seedStore(h); await seedSeller(b, { authProvider: null, providerId: null });
    expect((await svc().status(b.sellerId) as any).data).toMatchObject({ hasPassword: true, authProvider: null });
  });
});

describe('social re-authentication', () => {
  it('succeeds with a fresh sign-in whose provider id matches the account (no password needed)', async () => {
    const s = await seedStore(h); await seedSeller(s, { password: null });
    await svc().request(s.sellerId, { authProvider: 'google', socialId: 'g-123', token: 'idtok' });
    expect((await seller(s.sellerId)).status).toBe('pending_deletion');
    expect(auth.verifyProviderIdentity).toHaveBeenCalledWith('google', 'g-123', 'idtok');
  });

  it('succeeds when only the provider-verified email matches (e.g. password account that signs in with Apple)', async () => {
    const s = await seedStore(h); await seedSeller(s, { providerId: null, authProvider: null, email: 'owner@x.com' });
    providerEmail.v = 'owner@x.com';
    await svc().request(s.sellerId, { authProvider: 'apple', socialId: 'a-999', token: 't' });
    expect((await seller(s.sellerId)).status).toBe('pending_deletion');
  });

  it('refuses a different Google/Apple identity with INVALID_REAUTH', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'owner@x.com' });
    providerEmail.v = 'someone-else@x.com';
    await expect(svc().request(s.sellerId, { authProvider: 'google', socialId: 'g-OTHER', token: 't' })).rejects.toMatchObject({ response: { code: 'INVALID_REAUTH' } });
    // same provider id but under a different provider does not count
    await expect(svc().request(s.sellerId, { authProvider: 'apple', socialId: 'g-123', token: 't' })).rejects.toMatchObject({ response: { code: 'INVALID_REAUTH' } });
    expect((await seller(s.sellerId)).status).toBe('active');
  });

  it('refuses when the provider rejects the token, and when fields are missing', async () => {
    const s = await seedStore(h); await seedSeller(s);
    providerEmail.fail = true;
    await expect(svc().request(s.sellerId, { authProvider: 'google', socialId: 'g-123', token: 'forged' })).rejects.toMatchObject({ response: { code: 'INVALID_REAUTH' } });
    providerEmail.fail = false;
    await expect(svc().request(s.sellerId, { authProvider: 'google', socialId: 'g-123' })).rejects.toMatchObject({ response: { code: 'INVALID_REAUTH' } });
    await expect(svc().request(s.sellerId, { authProvider: 'facebook' as any, socialId: 'g-123', token: 't' })).rejects.toMatchObject({ response: { code: 'INVALID_REAUTH' } });
    expect((await seller(s.sellerId)).status).toBe('active');
  });

  it('a social-only account can NOT get through with an empty / any password', async () => {
    const s = await seedStore(h); await seedSeller(s, { password: null });
    for (const pw of [undefined, '', 'anything', null as any]) {
      await expect(svc().request(s.sellerId, { password: pw })).rejects.toMatchObject({ response: { code: 'INVALID_REAUTH' } });
    }
    expect((await seller(s.sellerId)).status).toBe('active');
  });

  it('password accounts keep the old rule', async () => {
    const s = await seedStore(h); await seedSeller(s);
    await expect(svc().request(s.sellerId, { password: 'nope' })).rejects.toMatchObject({ response: { code: 'INVALID_PASSWORD' } });
    await svc().request(s.sellerId, { password: 'pw-12345' });
    expect((await seller(s.sellerId)).status).toBe('pending_deletion');
  });
});

describe('public OTP-verified deletion (signed out)', () => {
  beforeEach(() => { sent.length = 0; otpService.sendOtp.mockClear(); });

  it('answers identically for unknown and known emails and only mails real active accounts', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'real@x.com' });
    const known = await svc().requestPublicOtp('Real@X.com ');
    const unknown = await svc().requestPublicOtp('ghost@x.com');
    expect(known).toEqual(unknown);
    expect(known.message).toBe(GENERIC_OTP_MESSAGE);
    expect(sent.map((m) => m.to)).toEqual(['real@x.com']);
    expect(await svc().requestPublicOtp('')).toEqual(known);
  });

  it('does not mail suspended, deleted or already-pending accounts (same generic answer)', async () => {
    for (const status of ['suspended', 'deleted', 'pending_deletion']) {
      const s = await seedStore(h); await seedSeller(s, { email: `${status}@x.com` });
      await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(s.sellerId) }, { $set: { status } });
      expect((await svc().requestPublicOtp(`${status}@x.com`)).message).toBe(GENERIC_OTP_MESSAGE);
    }
    expect(sent).toHaveLength(0);
  });

  it('has a per-email resend cooldown (no mail bombing)', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'real@x.com' });
    await svc().requestPublicOtp('real@x.com'); await svc().requestPublicOtp('real@x.com'); await svc().requestPublicOtp('real@x.com');
    expect(sent).toHaveLength(1);
  });

  it('confirm with the right code → pending_deletion with the same side effects as the in-app request', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'real@x.com' });
    await svc().requestPublicOtp('real@x.com');
    const res: any = await svc().confirmPublic('real@x.com', sent[0].otp, '1.2.3.4');
    expect(res.success).toBe(true);
    expect(res.data.graceDays).toBe(30);
    expect(res.hint).toMatch(/sign in/i);
    const sel = await seller(s.sellerId);
    expect(sel).toMatchObject({ status: 'pending_deletion', tokenVersion: 1, otp: null });
    expect((await h.repos.storeModel.collection.findOne({ _id: new Types.ObjectId(s.storeId) }) as any).status).toBe('suspended');
    const audit: any = await h.repos.posAuditLogModel.findOne({ action: 'account_deletion_requested' }).lean();
    expect(audit.metadata).toMatchObject({ via: 'email_otp', ip: '1.2.3.4' });
    // the code is single-use
    await expect(svc().confirmPublic('real@x.com', sent[0].otp)).rejects.toThrow();
  });

  it('works for a social-only account too (the mailbox is the proof)', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'social@x.com', password: null });
    await svc().requestPublicOtp('social@x.com');
    await svc().confirmPublic('social@x.com', sent[0].otp);
    expect((await seller(s.sellerId)).status).toBe('pending_deletion');
  });

  it('rejects a wrong code, an unknown email, an expired code, and locks the code after 5 wrong guesses', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'real@x.com' });
    await expect(svc().confirmPublic('ghost@x.com', '123456')).rejects.toThrow();
    await svc().requestPublicOtp('real@x.com');
    const good = sent[0].otp;
    const wrong = good === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) await expect(svc().confirmPublic('real@x.com', wrong)).rejects.toThrow();
    await expect(svc().confirmPublic('real@x.com', good)).rejects.toThrow(); // wiped after the 5th miss
    expect((await seller(s.sellerId)).status).toBe('active');

    // expiry
    await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(s.sellerId) }, { $set: { otp: '654321', otpAttempts: 0, otpExpiresAt: new Date(Date.now() - 1000) } });
    await expect(svc().confirmPublic('real@x.com', '654321')).rejects.toThrow();
    expect((await seller(s.sellerId)).status).toBe('active');
  });

  it('is refused while a register shift is open (same rule), and does not burn the code state silently', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'real@x.com' });
    await h.repos.registerSessionModel.collection.insertOne({ storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, status: 'open', openedAt: new Date() });
    await svc().requestPublicOtp('real@x.com');
    await expect(svc().confirmPublic('real@x.com', sent[0].otp)).rejects.toMatchObject({ response: { code: 'ACCOUNT_HAS_OPEN_SESSIONS' } });
    expect((await seller(s.sellerId)).status).toBe('active');
  });
});

describe('pending_deletion accounts can still sign in to cancel', () => {
  it('password login works during the grace period and cancel restores the account', async () => {
    const s = await seedStore(h); await seedSeller(s, { email: 'real@x.com' });
    await svc().request(s.sellerId, { password: 'pw-12345' });
    await h.repos.sellerModel.collection.updateOne({ _id: new Types.ObjectId(s.sellerId) }, { $set: { isVerified: true } });
    const stub: any = new Proxy({}, { get: () => jest.fn(async () => undefined) });
    const store: Record<string, string> = {};
    const authSvc = new AuthService({ repositories: h.repos } as any, otpService, { set: async (k: string, v: string) => { store[k] = v; }, isConnected: false } as any, stub, new JwtService({ secret: 'test-secret' }));
    const login: any = await authSvc.login({ email: 'real@x.com', password: 'pw-12345', role: 'seller' } as any);
    expect(login.success).toBe(true);
    await svc().cancel(s.sellerId);
    expect((await seller(s.sellerId)).status).toBe('active');
  });
});
