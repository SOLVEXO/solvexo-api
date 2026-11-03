/* eslint-disable prettier/prettier */
import { generateKeyPairSync } from 'crypto';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { SellerAccountDeletionService } from './seller-account-deletion.service';
import { AppleAuthClient, AppleTokenService, MAX_REVOKE_ATTEMPTS, encryptAppleToken } from '../auth/apple-token.service';
import { MongoHarness, seedStore, startMongoHarness } from '../pos/testing/mongo-harness';

/** 5G.1: Sign in with Apple token revocation when an account is purged — real Mongo, Apple stubbed (never called for real). */
jest.setTimeout(120_000);
let h: MongoHarness;
beforeAll(async () => { h = await startMongoHarness(); });
afterAll(async () => { await h?.stop(); });
beforeEach(async () => {
  await h.reset();
  process.env.APPLE_TOKEN_ENC_KEY = Buffer.alloc(32, 3).toString('base64');
  process.env.APPLE_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  process.env.APPLE_KEY_ID = 'K'; process.env.APPLE_TEAM_ID = 'T';
});

class FakeApple extends AppleAuthClient {
  revoked: { token: string; clientId: string }[] = [];
  fail = false;
  async exchangeCode(): Promise<string> { throw new Error('unused'); }
  async revoke(token: string, clientId: string) { if (this.fail) throw new Error('apple 400 invalid_request'); this.revoked.push({ token, clientId }); }
}
const setup = () => {
  const client = new FakeApple();
  const tokens = new AppleTokenService({ repositories: h.repos } as any, client);
  const svc = new SellerAccountDeletionService({ repositories: h.repos } as any, undefined, undefined, undefined, tokens);
  return { client, tokens, svc };
};
async function seedSeller(withToken: boolean) {
  const st = await seedStore(h);
  await h.repos.sellerModel.collection.insertOne({
    _id: new Types.ObjectId(st.sellerId), name: 'Olive', email: 'olive@x.com', role: 'seller', status: 'pending_deletion', isDelete: false, tokenVersion: 0,
    phone: '555', providerId: 'apple-sub', authProvider: 'apple', deletionScheduledFor: new Date(Date.now() - 1000),
    ...(withToken ? { appleRefreshTokenEnc: encryptAppleToken('the-apple-refresh-token'), appleClientId: 'com.solvexo.solvexoPos' } : {}),
  });
  return st.sellerId;
}
const raw = async (id: string): Promise<any> => h.repos.sellerModel.collection.findOne({ _id: new Types.ObjectId(id) });

describe('purge revokes the Apple token', () => {
  it('success: Apple gets the DECRYPTED token + the stored client id; the stored token is wiped; status done; account de-identified', async () => {
    const id = await seedSeller(true);
    const { svc, client } = setup();
    await svc.purge(id);
    expect(client.revoked).toEqual([{ token: 'the-apple-refresh-token', clientId: 'com.solvexo.solvexoPos' }]);
    const s = await raw(id);
    expect(s.appleRefreshTokenEnc).toBeNull();
    expect(s.appleClientId).toBeNull();
    expect(s.appleRevocation).toMatchObject({ status: 'done', attempts: 1, lastError: null });
    expect(s).toMatchObject({ status: 'deleted', isDelete: true, providerId: null, authProvider: null });
    expect(s.email).toMatch(/^deleted\+.*@deleted\.invalid$/);
  });

  it('is NOT called at the deletion REQUEST (the account is recoverable during the grace period)', async () => {
    const st = await seedStore(h);
    await h.repos.sellerModel.collection.insertOne({ _id: new Types.ObjectId(st.sellerId), name: 'O', email: 'o@x.com', role: 'seller', status: 'active', isDelete: false, tokenVersion: 0, providerId: 'apple-sub', authProvider: 'apple', appleRefreshTokenEnc: encryptAppleToken('t'), appleClientId: 'c' });
    const { svc, client } = setup();
    await svc.request(st.sellerId, undefined, undefined as any).catch(() => undefined); // re-auth is out of scope here — it may refuse
    expect(client.revoked).toHaveLength(0);
  });

  it('failure NEVER blocks deletion: the account is still de-identified, the failure is recorded (no secrets) and the token is kept for the retry', async () => {
    const id = await seedSeller(true);
    const { svc, client } = setup(); client.fail = true;
    await expect(svc.purge(id)).resolves.toBeUndefined();
    const s = await raw(id);
    expect(s).toMatchObject({ status: 'deleted', isDelete: true });
    expect(s.appleRefreshTokenEnc).toMatch(/^v1:/);
    expect(s.appleRevocation).toMatchObject({ status: 'pending', attempts: 1, lastError: expect.stringContaining('apple 400') });
    expect(new Date(s.appleRevocation.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(JSON.stringify(s.appleRevocation)).not.toContain('the-apple-refresh-token');
  });

  it('retryDue: skips until nextAttemptAt, then retries; success wipes the token', async () => {
    const id = await seedSeller(true);
    const { svc, tokens, client } = setup(); client.fail = true;
    await svc.purge(id);
    client.fail = false;
    expect(await tokens.retryDue(new Date())).toBe(0); // backoff not elapsed
    expect(client.revoked).toHaveLength(0);
    expect(await tokens.retryDue(new Date(Date.now() + 2 * 3_600_000))).toBe(1);
    expect(client.revoked).toHaveLength(1);
    const s = await raw(id);
    expect(s.appleRefreshTokenEnc).toBeNull();
    expect(s.appleRevocation.status).toBe('done');
  });

  it('backs off exponentially and gives up loudly after MAX attempts (status failed, no more calls)', async () => {
    const id = await seedSeller(true);
    const { svc, tokens, client } = setup(); client.fail = true;
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await svc.purge(id);
    let t = Date.now();
    let prev = new Date((await raw(id)).appleRevocation.nextAttemptAt).getTime() - t;
    for (let i = 2; i <= MAX_REVOKE_ATTEMPTS; i++) {
      t += 48 * 3_600_000;
      await tokens.retryDue(new Date(t));
      const a = (await raw(id)).appleRevocation;
      expect(a.attempts).toBe(i);
      if (i < MAX_REVOKE_ATTEMPTS) { const gap = new Date(a.nextAttemptAt).getTime() - t; expect(gap).toBeGreaterThanOrEqual(prev); prev = gap; }
    }
    const fin = (await raw(id)).appleRevocation;
    expect(fin).toMatchObject({ status: 'failed', attempts: MAX_REVOKE_ATTEMPTS, nextAttemptAt: null });
    expect(err.mock.calls.some((c) => String(c[0]).includes('GAVE UP'))).toBe(true);
    expect(await tokens.retryDue(new Date(t + 99 * 3_600_000))).toBe(0);
    err.mockRestore();
  });

  it('no stored token (e.g. Google/password owner) → Apple is never called', async () => {
    const id = await seedSeller(false);
    const { svc, client } = setup();
    await svc.purge(id);
    expect(client.revoked).toHaveLength(0);
    expect((await raw(id)).appleRevocation ?? null).toBeNull();
    expect((await raw(id)).status).toBe('deleted');
  });

  it('missing Apple config → revocation skipped and logged, deletion still completes, token kept pending for when it is configured', async () => {
    const id = await seedSeller(true);
    delete process.env.APPLE_PRIVATE_KEY;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, client } = setup();
    await svc.purge(id);
    expect(client.revoked).toHaveLength(0);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('not configured'))).toBe(true);
    const s = await raw(id);
    expect(s).toMatchObject({ status: 'deleted', isDelete: true });
    expect(s.appleRevocation).toMatchObject({ status: 'pending', lastError: 'not_configured' });
    expect(s.appleRefreshTokenEnc).toMatch(/^v1:/);
    warn.mockRestore();
  });

  it('purgeDue purges the due account and revokes in the same run', async () => {
    const id = await seedSeller(true);
    const { svc, client } = setup();
    expect(await svc.purgeDue()).toBe(1);
    expect(client.revoked).toHaveLength(1);
    expect((await raw(id)).status).toBe('deleted');
  });
});
