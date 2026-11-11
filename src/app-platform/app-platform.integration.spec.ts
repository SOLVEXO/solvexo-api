/* eslint-disable prettier/prettier */
/**
 * App platform: pure validation / token signing, then the service on a real MongoDB (direct calls).
 *   MONGO_TEST_URI="mongodb://127.0.0.1:27096/?directConnection=true" npx jest --runInBand --forceExit app-platform.integration
 */
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import mongoose, { Connection } from 'mongoose';
import { ApiTokenGuard, ApiTokensService } from '../merchant-api/api-tokens.service';
import { ApiTokenSchema, WebhookSubscriptionSchema } from '../merchant-api/merchant-api.schema';
import { API_SCOPE_KEY } from '../merchant-api/api-tokens.service';
import { decryptCredential } from '../common/credential-encryption.util';
import { AppAuthCodeSchema, AppDefinitionSchema, AppInstallSchema } from './app.schema';
import { AppPlatformService } from './app-platform.service';
import { exactRedirect, grantable, hashSecret, httpsUrl, safeEqualHex, signSessionToken, validateApp, verifySessionToken } from './app-platform.util';

const URI = process.env.MONGO_TEST_URI;
const d = URI ? describe : describe.skip;
const CB = 'https://app.example.com/oauth/callback';

describe('app platform util (pure)', () => {
  it('https addresses: public domains only', () => {
    expect(httpsUrl(CB, 'x').ok).toBe(true);
    for (const bad of ['http://app.example.com/cb', 'https://localhost/cb', 'https://127.0.0.1/cb', 'https://user:pw@app.example.com/cb', 'https://intranet/cb', 'https://app.local/cb', 'https://app.example.com/cb#frag', 'javascript:alert(1)', 'nope']) expect(httpsUrl(bad, 'x').ok).toBe(false);
  });
  it('redirect match is exact (no prefix, case or slash tricks)', () => {
    const reg = [CB];
    expect(exactRedirect(reg, CB)).toBe(true);
    for (const bad of [`${CB}/evil`, `${CB}/`, CB.toUpperCase(), `${CB}?x=1`, 'https://app.example.com', 'https://evil.com/oauth/callback', undefined, 5]) expect(exactRedirect(reg, bad as any)).toBe(false);
  });
  it('the owner can grant only what the app registered', () => {
    expect(grantable(['read_orders', 'read_products'], ['read_orders'])).toEqual(['read_orders']);
    expect(grantable(['read_orders'], undefined)).toEqual(['read_orders']);
    expect(grantable(['read_orders'], ['write_orders'])).toBeNull();
    expect(grantable(['read_orders'], ['read_orders', 'write_products'])).toBeNull();
  });
  it('app registration validation', () => {
    const ok = { name: 'Reports', redirectUrls: [CB], requestedScopes: ['read_orders'], webhookUrl: 'https://app.example.com/hook', webhookEvents: ['order.paid'], embedUrl: 'https://app.example.com/embed' };
    expect(validateApp(ok, false).ok).toBe(true);
    expect(validateApp({ ...ok, requestedScopes: ['read_orders', 'admin_everything'] }, false).ok).toBe(false);
    expect(validateApp({ ...ok, requestedScopes: [] }, false).ok).toBe(false);
    expect(validateApp({ ...ok, redirectUrls: ['http://x.com/cb'] }, false).ok).toBe(false);
    expect(validateApp({ ...ok, redirectUrls: Array.from({ length: 6 }, (_, i) => `https://a${i}.example.com/cb`) }, false).ok).toBe(false);
    expect(validateApp({ ...ok, webhookEvents: ['order.exploded'] }, false).ok).toBe(false);
    expect(validateApp({ ...ok, embedUrl: 'http://x.com' }, false).ok).toBe(false);
    expect(validateApp({ ...ok, name: ' ' }, false).ok).toBe(false);
  });
  it('session token: signed, expires, tamper-proof, secret-bound', () => {
    const t = signSessionToken('secret-1', { aud: 'app_x', sub: 'u1', store: 's1', install: 'i1' }, 1000);
    expect(verifySessionToken('secret-1', t, 1100)).toMatchObject({ ok: true, claims: { aud: 'app_x', store: 's1', sub: 'u1' } });
    expect(verifySessionToken('secret-2', t, 1100).ok).toBe(false);
    expect(verifySessionToken('secret-1', t, 1000 + 301).ok).toBe(false);
    const [h, , sig] = t.split('.'); const forged = Buffer.from(JSON.stringify({ iss: 'solvexo', aud: 'app_x', sub: 'u1', store: 'OTHER', install: 'i1', exp: 99999999999 })).toString('base64url');
    expect(verifySessionToken('secret-1', `${h}.${forged}.${sig}`, 1100).ok).toBe(false);
    expect(verifySessionToken('secret-1', 'a.b', 1100).ok).toBe(false);
    expect(safeEqualHex(hashSecret('a'), hashSecret('a'))).toBe(true);
    expect(safeEqualHex(hashSecret('a'), hashSecret('b'))).toBe(false);
  });
});

d('app platform service (real Mongo, direct calls)', () => {
  let conn: Connection; let m: any; let svc: AppPlatformService; let notified: any[]; let entitlementOk: boolean;
  const admin = { id: 'adm1', role: 'admin' }; const owner = { id: 'own1', role: 'seller' };
  const A = 'a1'.repeat(12); const B = 'b2'.repeat(12);

  beforeAll(async () => {
    process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY = process.env.INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY || 'a'.repeat(64);
    conn = await mongoose.createConnection(URI as string, { dbName: `apps_it_${Date.now()}` }).asPromise();
    m = {
      apps: conn.model('AppDefinition', AppDefinitionSchema), installs: conn.model('AppInstall', AppInstallSchema), codes: conn.model('AppAuthCode', AppAuthCodeSchema),
      tokens: conn.model('ApiToken', ApiTokenSchema), subs: conn.model('WebhookSubscription', WebhookSubscriptionSchema),
      stores: conn.model('Store', new mongoose.Schema({ _id: String }, { strict: false })),
    };
    await Promise.all(Object.values(m).map((x: any) => x.init()));
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });
  beforeEach(async () => {
    for (const x of Object.values(m) as any[]) await x.deleteMany({});
    await m.stores.create([{ _id: A, isDelete: false }, { _id: B, isDelete: false }]);
    notified = []; entitlementOk = true;
    svc = new AppPlatformService(m.apps, m.installs, m.codes, m.tokens, m.subs, { repositories: { storeModel: m.stores } } as any, { log: jest.fn().mockResolvedValue(undefined) } as any,
      { assertFeatureAllowed: async () => { if (!entitlementOk) throw new ForbiddenException('Upgrade'); } } as any);
    (svc as any).notifyApp = async (...a: any[]) => { notified.push(a); };
  });

  const reg = async (extra: any = {}, approve = true) => {
    const r = await svc.createApp(admin, { name: 'Reports', description: 'x', redirectUrls: [CB], requestedScopes: ['read_orders', 'read_products'], webhookUrl: 'https://app.example.com/hook', webhookEvents: ['order.paid'], uninstallWebhookUrl: 'https://app.example.com/gone', embedUrl: 'https://app.example.com/embed', embedTitle: 'Reports', ...extra });
    if (approve) await svc.approve(admin, r.id);
    return r;
  };
  const consent = async (app: { clientId: string }, store = A, extra: any = {}) => {
    const r = await svc.authorize(store, owner, { client_id: app.clientId, redirect_uri: CB, scope: 'read_orders', state: 'st_123', ...extra });
    const u = new URL(r.redirectTo); return { code: u.searchParams.get('code') as string, state: u.searchParams.get('state'), url: u };
  };
  const swap = (app: any, code: string, extra: any = {}) => svc.exchange({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: CB, ...extra });

  it('registry: secrets shown once and never listed; a draft app cannot be installed; approve once', async () => {
    const r = await reg({}, false);
    expect(r.clientSecret).toMatch(/^appsec_/); expect(r.sessionSecret).toMatch(/^appses_/);
    const list: any[] = await svc.listApps();
    expect(JSON.stringify(list)).not.toMatch(/appsec_|clientSecretHash|sessionSecretEnc/);
    expect(await svc.listAvailable(A)).toHaveLength(0);
    await expect(svc.authorize(A, owner, { client_id: r.clientId, redirect_uri: CB, scope: 'read_orders', state: 'x1' })).rejects.toThrow(/not available/);
    await svc.approve(admin, r.id);
    await expect(svc.approve(admin, r.id)).rejects.toThrow(/already approved/);
    expect(await svc.listAvailable(A)).toHaveLength(1);
  });

  it('consent: only registered redirects, a required state, only requested scopes, existing store', async () => {
    const r = await reg();
    const base = { client_id: r.clientId, redirect_uri: CB, scope: 'read_orders', state: 'st_1' };
    await expect(svc.authorize(A, owner, { ...base, redirect_uri: `${CB}/evil` })).rejects.toThrow(/redirect/);
    await expect(svc.authorize(A, owner, { ...base, redirect_uri: 'https://evil.com/cb' })).rejects.toThrow(/redirect/);
    await expect(svc.authorize(A, owner, { ...base, state: '' })).rejects.toThrow(/state/);
    await expect(svc.authorize(A, owner, { ...base, state: 'has space' })).rejects.toThrow(/state/);
    await expect(svc.authorize(A, owner, { ...base, scope: 'write_orders' })).rejects.toThrow(/permissions/);
    await expect(svc.authorize(A, owner, { ...base, client_id: 'nope' })).rejects.toThrow(/not available/);
    await expect(svc.authorize('c3'.repeat(12), owner, base)).rejects.toThrow(/Store not found/);
    const pv: any = await svc.preview(A, base);
    expect(pv.scopes).toEqual(['read_orders']); expect(pv.scopeLabels[0]).toMatch(/orders/i); expect(pv.alreadyInstalled).toBe(false);
    const ok = await consent(r);
    expect(ok.state).toBe('st_123'); // state is echoed untouched
    expect(ok.url.origin + ok.url.pathname).toBe(CB); expect(ok.code).toMatch(/^code_/);
  });

  it('a plan without API access cannot give consent', async () => {
    const r = await reg(); entitlementOk = false;
    await expect(svc.authorize(A, owner, { client_id: r.clientId, redirect_uri: CB, scope: 'read_orders', state: 'x1' })).rejects.toThrow(/Upgrade/);
  });

  it('code exchange: needs the right secret, code, redirect and app; single use (also in parallel); expires', async () => {
    const r = await reg(); const other = await reg({ name: 'Other app', redirectUrls: [CB] });
    const { code } = await consent(r);
    await expect(swap({ ...r, clientSecret: 'wrong' }, code)).rejects.toThrow(UnauthorizedException);
    await expect(svc.exchange({ client_id: 'unknown', client_secret: 'x', code, redirect_uri: CB })).rejects.toThrow(UnauthorizedException);
    await expect(swap(r, code, { redirect_uri: `${CB}/x` })).rejects.toThrow(/invalid_grant/);
    await expect(swap(other, code)).rejects.toThrow(/invalid_grant/); // another app's valid secret cannot redeem it
    await expect(swap(r, 'code_nonsense')).rejects.toThrow(/invalid_grant/);
    const res = await Promise.allSettled([swap(r, code), swap(r, code), swap(r, code)]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await expect(swap(r, code)).rejects.toThrow(/invalid_grant/);
    const { code: c2 } = await consent(r);
    await m.codes.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(swap(r, c2)).rejects.toThrow(/invalid_grant/);
  });

  it('install creates exactly the granted token + the app webhook, stored hashed/encrypted, visible to this store only', async () => {
    const r = await reg(); const { code } = await consent(r);
    const t: any = await swap(r, code);
    expect(t).toMatchObject({ token_type: 'bearer', scope: 'read_orders', store_id: A });
    expect(t.access_token).toMatch(/^sxk_[0-9a-f]{40}$/); expect(t.webhook_secret).toMatch(/^whsec_/);
    const tok: any = await m.tokens.findOne({ storeId: A }).lean();
    expect(tok.scopes).toEqual(['read_orders']); expect(tok.appInstallId).toBe(t.install_id); expect(tok.tokenHash).not.toContain('sxk_');
    const sub: any = await m.subs.findOne({ storeId: A }).select('+secretEnc').lean();
    expect(sub).toMatchObject({ url: 'https://app.example.com/hook', events: ['order.paid'], appInstallId: t.install_id });
    expect(decryptCredential(sub.secretEnc, 'INTEGRATIONS')).toBe(t.webhook_secret);
    expect((await svc.listInstalled(A))).toHaveLength(1);
    expect((await svc.listInstalled(B))).toHaveLength(0);
    expect((await svc.listAvailable(A))[0].installed).toBe(true);
    expect((await svc.listAvailable(B))[0].installed).toBe(false);
  });

  it('the app token obeys its scopes through the merchant API guard, and stops working on uninstall', async () => {
    const r = await reg(); const { code } = await consent(r); const t: any = await swap(r, code);
    const tokenSvc = new ApiTokensService(m.tokens, { log: jest.fn().mockResolvedValue(undefined) } as any);
    const guard = new ApiTokenGuard(tokenSvc, new Reflector());
    const ctxFor = (scope: string, bearer: string) => { const handler = () => undefined; Reflect.defineMetadata(API_SCOPE_KEY, scope, handler); return { getHandler: () => handler, switchToHttp: () => ({ getRequest: () => ({ headers: { authorization: `Bearer ${bearer}` } }) }) } as unknown as ExecutionContext; };
    await expect(guard.canActivate(ctxFor('read_orders', t.access_token))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor('write_products', t.access_token))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(ctxFor('read_products', t.access_token))).rejects.toThrow(ForbiddenException);
    await svc.uninstall(A, owner, t.install_id);
    await expect(guard.canActivate(ctxFor('read_orders', t.access_token))).rejects.toThrow(UnauthorizedException);
  });

  it('uninstall: token revoked, webhook deleted, app told once, history kept; another store cannot uninstall it', async () => {
    const r = await reg(); const t: any = await swap(r, (await consent(r)).code);
    await expect(svc.uninstall(B, owner, t.install_id)).rejects.toThrow(/not found/i);
    expect(await m.tokens.countDocuments({ appInstallId: t.install_id, revokedAt: null })).toBe(1);
    await svc.uninstall(A, owner, t.install_id);
    await expect(svc.uninstall(A, owner, t.install_id)).rejects.toThrow(/not found/i);
    expect(await m.tokens.countDocuments({ appInstallId: t.install_id, revokedAt: null })).toBe(0);
    expect(await m.subs.countDocuments({ appInstallId: t.install_id })).toBe(0);
    expect(((await m.installs.findById(t.install_id)) as any).status).toBe('uninstalled');
    await new Promise((res) => setImmediate(res));
    expect(notified).toHaveLength(1);
    expect(notified[0][0]).toBe('https://app.example.com/gone'); expect(notified[0][2]).toBe('app.uninstalled'); expect(notified[0][3]).toMatchObject({ store_id: A, install_id: t.install_id, reason: 'uninstalled' });
    expect(decryptCredential((await m.apps.findOne({}).select('+sessionSecretEnc').lean() as any).sessionSecretEnc, 'INTEGRATIONS')).toBe(notified[0][1]);
    expect(await svc.listInstalled(A)).toHaveLength(0);
  });

  it('installing again replaces the old install (old token dead, one live install)', async () => {
    const r = await reg(); const t1: any = await swap(r, (await consent(r)).code); const t2: any = await swap(r, (await consent(r)).code);
    expect(t2.install_id).not.toBe(t1.install_id);
    expect(await m.installs.countDocuments({ storeId: A, status: 'installed' })).toBe(1);
    expect(await m.tokens.countDocuments({ storeId: A, revokedAt: null })).toBe(1);
    expect(await m.subs.countDocuments({ storeId: A })).toBe(1);
    expect(notified).toHaveLength(0); // a reinstall is not an uninstall
  });

  it('suspending an app removes it from every store at once and blocks new installs', async () => {
    const r = await reg(); const ta: any = await swap(r, (await consent(r, A)).code); const tb: any = await swap(r, (await consent(r, B)).code);
    expect(await m.installs.countDocuments({ status: 'installed' })).toBe(2);
    const out: any = await svc.suspend(admin, r.id);
    expect(out.uninstalled).toBe(2);
    expect(await m.installs.countDocuments({ status: 'installed' })).toBe(0);
    expect(await m.tokens.countDocuments({ revokedAt: null })).toBe(0); expect(await m.subs.countDocuments({})).toBe(0);
    await expect(svc.authorize(A, owner, { client_id: r.clientId, redirect_uri: CB, scope: 'read_orders', state: 'x1' })).rejects.toThrow(/not available/);
    await new Promise((res) => setImmediate(res));
    expect(notified.map((n) => n[3].reason)).toEqual(['suspended', 'suspended']);
    void ta; void tb;
  });

  it('dashboard page: a signed short-lived session token only for an installed app of this store', async () => {
    const r = await reg(); const t: any = await swap(r, (await consent(r)).code);
    const s: any = await svc.sessionToken(A, owner, t.install_id);
    expect(s.origin).toBe('https://app.example.com'); expect(s.embedUrl).toBe('https://app.example.com/embed');
    expect(verifySessionToken(r.sessionSecret, s.token)).toMatchObject({ ok: true, claims: { aud: r.clientId, store: A, sub: 'own1', install: t.install_id } });
    expect(verifySessionToken('another-secret', s.token).ok).toBe(false);
    await expect(svc.sessionToken(B, owner, t.install_id)).rejects.toThrow(/not found/i);
    const noPage = await reg({ name: 'Headless', embedUrl: null }); const t2: any = await swap(noPage, (await consent(noPage)).code);
    await expect(svc.sessionToken(A, owner, t2.install_id)).rejects.toThrow(/no page/);
    await svc.uninstall(A, owner, t.install_id);
    await expect(svc.sessionToken(A, owner, t.install_id)).rejects.toThrow(/not found/i);
  });
});
