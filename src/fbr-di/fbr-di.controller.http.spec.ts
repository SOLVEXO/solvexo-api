/* eslint-disable prettier/prettier */
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AdminFbrDiController, StoreFbrDiController } from './fbr-di.controller';
import { FbrDiService } from './fbr-di.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest');

/**
 * Real HTTP through real Nest: the throttle decorators, the validation pipe and the owner-only rule on the FBR routes.
 * Auth guards are replaced by one that takes the role from the `x-test-role` header (their own behaviour is covered elsewhere);
 * the service is a stub that records calls.
 */
describe('FBR routes over HTTP: throttle, validation, owner-only', () => {
  let app: INestApplication;
  let server: any;
  const seen: { fn: string; args: any[] }[] = [];
  const rec = (fn: string) => async (...args: any[]) => { seen.push({ fn, args }); return { ok: true, fn }; };
  const serviceStub = {
    getPlatformSettings: rec('getPlatformSettings'), updatePlatformSettings: rec('updatePlatformSettings'), testPlatform: rec('testPlatform'),
    platformToken: () => null, provinces: rec('provinces'), list: rec('list'), retry: rec('retry'), resolve: rec('resolve'),
    getStoreSettings: rec('getStoreSettings'), updateStoreSettings: rec('updateStoreSettings'), setStoreToken: rec('setStoreToken'),
    deleteStoreToken: rec('deleteStoreToken'), testStore: rec('testStore'), provincesForStore: rec('provincesForStore'),
    orderInvoice: rec('orderInvoice'), planInvoicesForStore: rec('planInvoicesForStore'), solvexoInvoiceDocument: rec('solvexoInvoiceDocument'),
  };
  const fakeAuth = {
    canActivate: (ctx: any) => {
      const req = ctx.switchToHttp().getRequest();
      const role = String(req.headers['x-test-role'] ?? 'seller');
      req.user = { userId: 'user-1', role, storeId: 'st1', sellerId: 'sl1', permissions: ['settings.taxes.manage'] };
      return true;
    },
  };

  /** A fresh Nest app (and so a fresh throttle counter). */
  async function startApp(): Promise<{ app: INestApplication; server: any }> {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 1000 }])],
      controllers: [AdminFbrDiController, StoreFbrDiController],
      providers: [{ provide: FbrDiService, useValue: serviceStub }, { provide: APP_GUARD, useClass: ThrottlerGuard }],
    })
      .overrideGuard(JwtAuthGuard).useValue(fakeAuth)
      .overrideGuard(RolesGuard).useValue({ canActivate: () => true })
      .overrideGuard(PermissionsGuard).useValue({ canActivate: () => true })
      .compile();
    const a = mod.createNestApplication();
    await a.init();
    return { app: a, server: a.getHttpServer() };
  }
  beforeAll(async () => { ({ app, server } = await startApp()); });
  afterAll(async () => { await app.close(); });

  const TOKEN = 'a'.repeat(32);
  /** Calls the same route 11 times: the first 10 must pass, the 11th must be rejected with 429. */
  async function expectThrottled(method: 'get' | 'post' | 'put' | 'delete', path: string, role: string, body?: any) {
    const fresh = await startApp(); // own app: the counter starts at zero
    try { await runThrottle(fresh.server, method, path, role, body); } finally { await fresh.app.close(); }
  }
  async function runThrottle(server: any, method: 'get' | 'post' | 'put' | 'delete', path: string, role: string, body?: any) {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      let r = request(server)[method](path).set('x-test-role', role);
      if (body !== undefined) r = r.send(body);
      statuses.push((await r).status);
    }
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  }

  it('429 after 10 calls per minute: admin sandbox test', () => expectThrottled('post', '/api/admin/fbr-di/test', 'admin'));
  it('429 after 10 calls per minute: admin retry', () => expectThrottled('post', '/api/admin/fbr-di/invoices/inv-retry/retry', 'admin'));
  it('429 after 10 calls per minute: admin resolve', () => expectThrottled('post', '/api/admin/fbr-di/invoices/inv-resolve/resolve', 'admin', { action: 'resend' }));
  it('429 after 10 calls per minute: store token save', () => expectThrottled('put', '/api/fbr-di/st1/token', 'seller', { mode: 'sandbox', token: TOKEN }));
  it('429 after 10 calls per minute: store token delete', () => expectThrottled('delete', '/api/fbr-di/st1/token/sandbox', 'seller'));
  it('429 after 10 calls per minute: store sandbox test', () => expectThrottled('post', '/api/fbr-di/st1/test', 'seller'));
  it('429 after 10 calls per minute: store retry', () => expectThrottled('post', '/api/fbr-di/st1/invoices/inv-s-retry/retry', 'seller'));
  it('429 after 10 calls per minute: store resolve', () => expectThrottled('post', '/api/fbr-di/st1/invoices/inv-s-resolve/resolve', 'seller', { action: 'resend' }));

  it('plain reads are not throttled at 10 per minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) statuses.push((await request(server).get('/api/fbr-di/st1/settings').set('x-test-role', 'seller')).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const inv: number[] = [];
    for (let i = 0; i < 15; i++) inv.push((await request(server).get('/api/admin/fbr-di/invoices').set('x-test-role', 'admin')).status);
    expect(inv.every((s) => s === 200)).toBe(true);
  });

  it('resolve validates the body: "filed" needs a well-formed FBR number, unknown fields are refused', async () => {
    const post = (path: string, body: any) => request(server).post(path).set('x-test-role', 'admin').send(body);
    expect((await post('/api/admin/fbr-di/invoices/v1/resolve', { action: 'filed' })).status).toBe(400);
    expect((await post('/api/admin/fbr-di/invoices/v2/resolve', { action: 'filed', fbrInvoiceNumber: 'abc' })).status).toBe(400);
    expect((await post('/api/admin/fbr-di/invoices/v3/resolve', { action: 'frobnicate' })).status).toBe(400);
    expect((await post('/api/admin/fbr-di/invoices/v4/resolve', { action: 'resend', extra: 'x' })).status).toBe(400);
    expect((await post('/api/admin/fbr-di/invoices/v5/resolve', { action: 'filed', fbrInvoiceNumber: '7000007DI1747119701593', fbrDated: 'yesterday' })).status).toBe(400);
    const okFiled = await post('/api/admin/fbr-di/invoices/v6/resolve', { action: 'filed', fbrInvoiceNumber: '7000007DI1747119701593', fbrDated: '2026-11-11 10:05:00' });
    expect(okFiled.status < 300).toBe(true);
    const call = seen.filter((s) => s.fn === 'resolve').pop()!;
    expect(call.args[0]).toBe('v6');
    expect(call.args[1]).toEqual({ issuer: 'platform' });
    expect(call.args[2].action).toBe('filed');
    expect(call.args[3]).toEqual({ id: 'user-1', role: 'admin' }); // who did it comes from the login, never from the body
  });

  it('the store routes that change anything are for the OWNER only: a staff session gets 403 and nothing is called', async () => {
    const before = seen.length;
    const t = (r: any) => r.set('x-test-role', 'staff');
    const results = [
      (await t(request(server).put('/api/fbr-di/st1/settings').send({ enabled: false }))).status,
      (await t(request(server).put('/api/fbr-di/st1/token').send({ mode: 'sandbox', token: TOKEN }))).status,
      (await t(request(server).delete('/api/fbr-di/st1/token/sandbox'))).status,
      (await t(request(server).post('/api/fbr-di/st1/test'))).status,
      (await t(request(server).post('/api/fbr-di/st1/invoices/x/retry'))).status,
      (await t(request(server).post('/api/fbr-di/st1/invoices/x/resolve').send({ action: 'resend' }))).status,
    ];
    expect(results.every((s) => s === 403 || s === 429)).toBe(true);
    expect(seen.length).toBe(before);
  });

  it('the store resolve passes the signed-in OWNER and the store from the URL to the service', async () => {
    await request(server).post('/api/fbr-di/st1/invoices/own-1/resolve').set('x-test-role', 'seller').send({ action: 'resend' });
    const call = seen.filter((s) => s.fn === 'resolve').pop()!;
    expect(call.args[0]).toBe('own-1');
    expect(call.args[1]).toEqual({ issuer: 'store', storeId: 'st1' });
    expect(call.args[3]).toEqual({ id: 'user-1', role: 'seller' });
  });
});
