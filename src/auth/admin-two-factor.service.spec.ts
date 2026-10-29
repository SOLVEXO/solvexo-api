/* eslint-disable prettier/prettier */
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AdminTwoFactorService } from './admin-two-factor.service';
import { currentTotpStep, totpAt } from '../common/totp.util';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

/** Minimal in-memory stand-in for the Admin model: findById(...).select(...)[.lean()] and updateOne with $set/$pull + simple filters. */
function makeAdminModel(doc: any) {
  const matches = (filter: any) => Object.entries(filter).every(([k, v]: [string, any]) => {
    if (k === '_id') return true;
    if (v && typeof v === 'object' && '$lt' in v) return (doc[k] ?? undefined) !== undefined && doc[k] < v.$lt;
    if (Array.isArray(doc[k])) return doc[k].includes(v);
    return doc[k] === v;
  });
  const query = () => { const q: any = Promise.resolve(doc); q.select = () => q; q.lean = () => q; return q; };
  return {
    doc,
    findById: jest.fn(() => query()),
    updateOne: jest.fn(async (filter: any, update: any) => {
      if (!matches(filter)) return { modifiedCount: 0 };
      Object.assign(doc, update.$set ?? {});
      for (const [k, v] of Object.entries(update.$pull ?? {})) doc[k] = (doc[k] ?? []).filter((x: any) => x !== v);
      return { modifiedCount: 1 };
    }),
  };
}

function makeService(doc: any) {
  const adminModel = makeAdminModel(doc);
  const config = { get: (k: string) => process.env[k] };
  const svc = new AdminTwoFactorService({ repositories: { adminModel } } as any, new JwtService({}), config as any);
  return { svc, adminModel };
}

describe('AdminTwoFactorService', () => {
  it('sets up, enables with a real code, then accepts a login code once (no replay)', async () => {
    const doc: any = { _id: 'a1', email: 'owner@solvexo.test', twoFactorEnabled: false, tokenVersion: 0 };
    const { svc } = makeService(doc);

    const setup = await svc.startSetup('a1');
    expect(setup.data.otpauthUri).toContain('otpauth://totp/');
    expect(doc.twoFactorPendingSecret).toBeTruthy();
    expect(doc.twoFactorPendingSecret).not.toContain(setup.data.secret); // stored encrypted

    await expect(svc.confirmSetup('a1', '000000')).rejects.toThrow("didn't match");
    // Enable with the previous step's code so the login code below (current step) is newer.
    const enabled = await svc.confirmSetup('a1', totpAt(setup.data.secret, currentTotpStep() - 1));
    expect(doc.twoFactorEnabled).toBe(true);
    expect(enabled.data.recoveryCodes).toHaveLength(10);
    expect(doc.twoFactorRecoveryCodes).not.toContain(enabled.data.recoveryCodes[0]); // stored hashed

    const code = totpAt(setup.data.secret, currentTotpStep());
    expect((await svc.verifyLoginCode('a1', code)).ok).toBe(true);
    expect((await svc.verifyLoginCode('a1', code)).ok).toBe(false); // same code again = replay
  });

  it('accepts each recovery code exactly once', async () => {
    const doc: any = { _id: 'a1', email: 'x@y.z', twoFactorEnabled: false };
    const { svc } = makeService(doc);
    const setup = await svc.startSetup('a1');
    const { data } = await svc.confirmSetup('a1', totpAt(setup.data.secret, currentTotpStep()));
    const rc = data.recoveryCodes[3];

    const first = await svc.verifyLoginCode('a1', rc.toLowerCase());
    expect(first).toEqual({ ok: true, usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect((await svc.verifyLoginCode('a1', rc)).ok).toBe(false);
  });

  it('challenge tokens verify only with the 2FA secret, never as a session token', () => {
    const { svc } = makeService({ _id: 'a1' });
    const token = svc.signChallenge({ _id: 'a1', tokenVersion: 4 });
    expect(svc.verifyChallenge(token)).toEqual({ adminId: 'a1', tokenVersion: 4 });
    expect(() => new JwtService({}).verify(token, { secret: process.env.JWT_SECRET })).toThrow();
    expect(() => svc.verifyChallenge(new JwtService({}).sign({ sub: 'a1' }, { secret: process.env.JWT_SECRET }))).toThrow('expired');
  });

  it('turning off needs the password and a valid code', async () => {
    const doc: any = { _id: 'a1', email: 'x@y.z', twoFactorEnabled: false, password: await bcrypt.hash('right-pass', 4) };
    const { svc } = makeService(doc);
    const setup = await svc.startSetup('a1');
    await svc.confirmSetup('a1', totpAt(setup.data.secret, currentTotpStep() - 1));

    await expect(svc.disable('a1', 'wrong-pass', totpAt(setup.data.secret, currentTotpStep()))).rejects.toThrow('password');
    await expect(svc.disable('a1', 'right-pass', '000000')).rejects.toThrow("didn't match");
    await svc.disable('a1', 'right-pass', totpAt(setup.data.secret, currentTotpStep()));
    expect(doc.twoFactorEnabled).toBe(false);
    expect(doc.twoFactorSecret).toBeNull();
  });
});
