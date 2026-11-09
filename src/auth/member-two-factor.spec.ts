/* eslint-disable prettier/prettier */
/** Seller/staff two-factor on a real MongoDB (skipped without MONGO_TEST_URI): setup, login challenge, replay, lockout, recovery codes, step-up. */
import mongoose, { Connection } from 'mongoose';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { currentTotpStep, totpAt } from '../common/totp.util';
import { MemberTwoFactorSchema } from './member-two-factor.schema';
import { LOCK_MINUTES, MAX_FAILED_CODES, MemberTwoFactorService } from './member-two-factor.service';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;

d('MemberTwoFactorService', () => {
  jest.setTimeout(60000);
  let conn: Connection; let svc: MemberTwoFactorService; let n = 0; let id: string;
  const PASSWORD = 'Correct-horse-1';
  const secretOf = async (kind: string, m: string) => { const r: any = await conn.model('MemberTwoFactor').findOne({ kind, memberId: m }).lean(); return (svc as any).dec(r.secretEnc ?? r.pendingSecretEnc); };
  const code = async (kind: string, m: string, stepOffset = 0) => totpAt(await secretOf(kind, m), currentTotpStep() + stepOffset);
  const enable = async (kind: 'seller' | 'staff' = 'seller') => {
    const s = await svc.startSetup(kind, id, 'a@b.com');
    const r = await svc.confirmSetup(kind, id, totpAt(s.secret, currentTotpStep()));
    return r.recoveryCodes;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
    process.env.ADMIN_2FA_ENCRYPTION_KEY = process.env.ADMIN_2FA_ENCRYPTION_KEY || 'b'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `mtf_it_${Date.now()}` }).asPromise();
    const model = conn.model('MemberTwoFactor', MemberTwoFactorSchema); await model.init();
    const hash = await bcrypt.hash(PASSWORD, 4);
    const fake = (extra: any) => ({ findById: () => ({ select: () => ({ then: undefined, ...extra }) }) });
    const db: any = { repositories: {
      sellerModel: { findById: () => ({ select: async () => ({ password: hash }) }) },
      staffMemberModel: { findById: () => ({ select: async () => ({ passwordHash: hash }) }) },
    } }; void fake;
    svc = new MemberTwoFactorService(model as any, db, new JwtService({}), { get: (k: string) => process.env[k] } as any);
  });
  afterAll(async () => { await conn?.dropDatabase(); await conn?.close(); });
  beforeEach(() => { id = `m${++n}`; });

  it('setup does nothing for login until the first code is confirmed; a wrong first code is refused', async () => {
    const s = await svc.startSetup('seller', id, 'a@b.com');
    expect(await svc.isEnabled('seller', id)).toBe(false);
    await expect(svc.confirmSetup('seller', id, '000000')).rejects.toThrow(/didn't match/);
    const r = await svc.confirmSetup('seller', id, totpAt(s.secret, currentTotpStep()));
    expect(r.recoveryCodes).toHaveLength(10); expect(await svc.isEnabled('seller', id)).toBe(true);
    await expect(svc.startSetup('seller', id, 'a@b.com')).rejects.toThrow(/already on/);
  });

  it('the secret and recovery codes are not stored in readable form', async () => {
    const codes = await enable();
    const raw = JSON.stringify(await conn.model('MemberTwoFactor').findOne({ memberId: id }).lean());
    expect(raw).not.toContain(codes[0]); expect(raw).not.toContain(await secretOf('seller', id));
  });

  it('a code works once (replay), the next step\'s code works', async () => {
    await enable();
    const c = await code('seller', id, 1);
    expect((await svc.verifyCode('seller', id, c)).ok).toBe(true);
    expect((await svc.verifyCode('seller', id, c)).ok).toBe(false);
  });

  it('seller and staff accounts are separate even with the same id', async () => {
    await enable('seller');
    expect(await svc.isEnabled('staff', id)).toBe(false);
    expect((await svc.verifyCode('staff', id, '123456')).ok).toBe(false);
  });

  it('5 wrong codes lock for 15 minutes, even a right code is refused while locked', async () => {
    await enable();
    for (let i = 0; i < MAX_FAILED_CODES; i++) expect((await svc.verifyCode('seller', id, '111111')).ok).toBe(false);
    await expect(svc.verifyCode('seller', id, await code('seller', id, 1))).rejects.toThrow(/Too many wrong codes/);
    const row: any = await conn.model('MemberTwoFactor').findOne({ memberId: id }).lean();
    expect(new Date(row.lockedUntil).getTime()).toBeGreaterThan(Date.now() + (LOCK_MINUTES - 1) * 60_000);
  });

  it('a recovery code works exactly once', async () => {
    const codes = await enable();
    const first = await svc.verifyCode('seller', id, codes[0]);
    expect(first).toMatchObject({ ok: true, usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect((await svc.verifyCode('seller', id, codes[0])).ok).toBe(false);
    expect((await svc.verifyCode('seller', id, codes[1].toLowerCase().replace('-', ' '))).ok).toBe(true);
  });

  it('turning it off needs the password AND a code; resetting by the owner removes everything', async () => {
    await enable();
    await expect(svc.disable('seller', id, 'wrong', await code('seller', id, 1))).rejects.toThrow(/password is incorrect/);
    await expect(svc.disable('seller', id, PASSWORD, '000000')).rejects.toThrow(/didn't match/);
    await svc.disable('seller', id, PASSWORD, await code('seller', id, 1));
    expect(await svc.isEnabled('seller', id)).toBe(false);
    await enable(); await svc.reset('seller', id);
    expect(await svc.isEnabled('seller', id)).toBe(false); expect(await svc.model.countDocuments({ memberId: id })).toBe(0);
  });

  it('the login challenge is signed, short-lived to its purpose, and not a step-up token', async () => {
    const ch = svc.signChallenge('staff', id, { tokenVersion: 3, storeId: 's1' });
    expect(svc.verifyChallenge(ch)).toEqual({ kind: 'staff', memberId: id, tokenVersion: 3, storeId: 's1' });
    expect(() => svc.verifyChallenge('garbage')).toThrow(/expired/);
    await enable();
    const su = await svc.issueStepUp('seller', id, await code('seller', id, 1));
    expect(() => svc.verifyChallenge(su.token)).toThrow(/expired/);
  });

  it('step-up: members with 2FA need a fresh token of their own; members without it pass', async () => {
    await svc.assertStepUp('seller', id, undefined); // no 2FA: allowed
    await enable();
    await expect(svc.assertStepUp('seller', id, undefined)).rejects.toMatchObject({ response: { code: 'STEP_UP_REQUIRED' } });
    await expect(svc.assertStepUp('seller', id, 'junk')).rejects.toThrow(/authenticator/);
    const su = await svc.issueStepUp('seller', id, await code('seller', id, 1));
    await svc.assertStepUp('seller', id, su.token);
    const other = `${id}x`; await svc.startSetup('seller', other, 'o@b.com');
    const s2 = await secretOf('seller', other); await svc.confirmSetup('seller', other, totpAt(s2, currentTotpStep()));
    await expect(svc.assertStepUp('seller', other, su.token)).rejects.toThrow(/authenticator/); // someone else's token
    await expect(svc.assertStepUp('staff', id, su.token)).resolves.toBeUndefined(); // staff `id` has no 2FA
  });
});
