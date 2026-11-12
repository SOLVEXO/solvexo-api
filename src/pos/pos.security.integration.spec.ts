/* eslint-disable prettier/prettier */
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { RedisService } from '../redis/redis.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PosService } from './pos.service';
import { PosDeviceService } from './pos-device.service';
import { PosTokenRevocationService } from './pos-token-revocation.service';
import { PosAuthGuard, REQUIRE_MANAGER_PIN, RequireManagerPin } from './guards/pos-auth.guard';
import { runInDeviceScope } from './pos-device-scope';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';

/**
 * Phase 5D against a REAL MongoDB and a REAL Redis: device tokens (scope, revocation), manager-PIN gating for devices,
 * employee-token revocation (pin-logout / deactivation / PIN reset / lockout) incl. the offline "as of sale time" rule,
 * and per-device PIN rate limiting.
 */
jest.setTimeout(120_000);
let h: MongoHarness;
let redis: RedisService;
let devices: PosDeviceService;
let revocations: PosTokenRevocationService;
const HOUR = 3_600_000;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret';
  h = await startMongoHarness();
  redis = new RedisService();
  await redis.onModuleInit();
  if (!redis.isConnected) throw new Error('These tests need a Redis on REDIS_URL (default redis://localhost:6379)');
});
afterAll(async () => { await redis?.onModuleDestroy(); await h?.stop(); });
beforeEach(async () => { await h.reset(); devices = new PosDeviceService({ repositories: h.repos } as any); revocations = new PosTokenRevocationService(redis); });

const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
const makeService = () => new PosService({ repositories: h.repos } as any, activityLog as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any, revocations);
const makeGuard = () => new PosAuthGuard(redis, { repositories: h.repos } as any, new Reflector());
type Seed = Awaited<ReturnType<typeof seedStore>>;

const ctx = (req: any, handler: any = () => undefined) => ({ switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => class {} } as any);
const request = (token: string, extra: any = {}) => ({ params: {}, query: {}, body: {}, originalUrl: '/api/pos/x', ip: '1.2.3.4', ...extra, headers: { authorization: `Bearer ${token}`, ...(extra.headers ?? {}) } });
const codeOf = async (p: Promise<any>) => { try { await p; return 'NO_ERROR'; } catch (e: any) { return e.getResponse?.().code ?? e.message; } };
const registerDevice = async (s: Seed, name = 'Front iPad') => (await devices.register(s.sellerId, { storeId: s.storeId, registerId: s.registerId, name }, '9.9.9.9')).data;

describe('device registration & token', () => {
  it('the owner registers a device for one store+register and gets a token the guard accepts as that store\'s seller', async () => {
    const s = await seedStore(h);
    const d = await registerDevice(s);
    const req: any = request(d.deviceToken);
    expect(await makeGuard().canActivate(ctx(req))).toBe(true);
    expect(req.user).toMatchObject({ role: 'seller', userId: s.sellerId, storeId: s.storeId, posDevice: { deviceId: d.deviceId, registerId: s.registerId } });
    const row: any = await h.repos.posDeviceModel.findById(d.deviceId).lean();
    expect(row).toMatchObject({ status: 'active', storeId: s.storeId, name: 'Front iPad' });
  });

  it('refuses another seller\'s store and an unknown register', async () => {
    const a = await seedStore(h);
    const b = await seedStore(h);
    await expect(devices.register(b.sellerId, { storeId: a.storeId, registerId: a.registerId, name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(devices.register(a.sellerId, { storeId: a.storeId, registerId: new Types.ObjectId().toString(), name: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a forged / wrong-secret / non-device token is POS_DEVICE_INVALID', async () => {
    const s = await seedStore(h);
    const forged = jwt.sign({ type: 'pos_device', deviceId: new Types.ObjectId().toString(), storeId: s.storeId }, 'other-secret');
    expect(await codeOf(makeGuard().canActivate(ctx(request(forged))))).toBe('POS_DEVICE_INVALID');
    const ghost = jwt.sign({ type: 'pos_device', deviceId: new Types.ObjectId().toString(), storeId: s.storeId }, 'test-secret');
    expect(await codeOf(makeGuard().canActivate(ctx(request(ghost))))).toBe('POS_DEVICE_REVOKED'); // no such device row
  });

  it('list shows the store\'s devices; only that store\'s owner can list or revoke', async () => {
    const a = await seedStore(h); const b = await seedStore(h);
    const d = await registerDevice(a);
    const list: any = await devices.list(a.sellerId, a.storeId);
    expect(list.data.map((x: any) => String(x._id))).toEqual([d.deviceId]);
    await expect(devices.list(b.sellerId, a.storeId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(devices.revoke(b.sellerId, a.storeId, d.deviceId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('revocation is immediate (very next request), audited, and the old token never works again', async () => {
    const s = await seedStore(h);
    const d = await registerDevice(s);
    expect(await makeGuard().canActivate(ctx(request(d.deviceToken)))).toBe(true);
    await devices.revoke(s.sellerId, s.storeId, d.deviceId);
    expect(await codeOf(makeGuard().canActivate(ctx(request(d.deviceToken))))).toBe('POS_DEVICE_REVOKED');
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'device_revoked', targetId: d.deviceId })).toBe(1);
    // re-registering (same store) yields a NEW device — the old token stays dead
    const d2 = await registerDevice(s, 'Front iPad (again)');
    expect(d2.deviceId).not.toBe(d.deviceId);
    expect(await makeGuard().canActivate(ctx(request(d2.deviceToken)))).toBe(true);
    expect(await codeOf(makeGuard().canActivate(ctx(request(d.deviceToken))))).toBe('POS_DEVICE_REVOKED');
  });
});

describe('device scope: one store (+ one register to open a session)', () => {
  it('refuses a storeId in the path, query or body that is not the device\'s store', async () => {
    const s = await seedStore(h); const other = await seedStore(h);
    const d = await registerDevice(s);
    for (const where of ['params', 'query', 'body']) {
      const req: any = request(d.deviceToken, { [where]: { storeId: other.storeId } });
      expect(await codeOf(makeGuard().canActivate(ctx(req)))).toBe('POS_DEVICE_WRONG_STORE');
    }
    expect(await makeGuard().canActivate(ctx(request(d.deviceToken, { params: { storeId: s.storeId } })))).toBe(true);
  });

  it('opens a session on its OWN register only; synced sales may name another register of the same store', async () => {
    const s = await seedStore(h);
    const d = await registerDevice(s);
    const open: any = request(d.deviceToken, { originalUrl: '/api/pos/sessions/open', body: { storeId: s.storeId, registerId: new Types.ObjectId().toString() } });
    expect(await codeOf(makeGuard().canActivate(ctx(open)))).toBe('POS_DEVICE_WRONG_REGISTER');
    const sale: any = request(d.deviceToken, { originalUrl: '/api/pos/sales', body: { storeId: s.storeId, registerId: new Types.ObjectId().toString() } });
    expect(await makeGuard().canActivate(ctx(sale))).toBe(true);
  });

  it('routes that resolve the store from a sale/session id cannot reach another store (service-level scope)', async () => {
    const svc = makeService();
    const a = await seedStore(h); const b = await seedStore(h);
    // same seller owns both stores: only the DEVICE scope can stop the cross-store read
    await h.repos.storeModel.collection.updateOne({ _id: new Types.ObjectId(b.storeId) }, { $set: { sellerId: a.sellerId } });
    const scopeA = { storeId: a.storeId, deviceId: 'dev-a' };
    await expect(runInDeviceScope(scopeA, () => svc.getPosSettings(a.sellerId, b.storeId))).rejects.toMatchObject({ response: { code: 'POS_DEVICE_WRONG_STORE' } });
    await expect(runInDeviceScope(scopeA, () => svc.getPosSettings(a.sellerId, a.storeId))).resolves.toBeTruthy();
    // no device → the owner session is unrestricted
    await expect(svc.getPosSettings(a.sellerId, b.storeId)).resolves.toBeTruthy();
  });

  it('JwtAuthGuard (every non-POS route) refuses device and PIN-session tokens', async () => {
    const proto = Object.getPrototypeOf(JwtAuthGuard.prototype);
    const spy = jest.spyOn(proto, 'canActivate').mockResolvedValue(true);
    try {
      const g = new JwtAuthGuard(redis, { repositories: h.repos } as any);
      for (const tokenType of ['pos_device', 'pos_employee']) {
        const req: any = { headers: { authorization: 'Bearer x' }, user: { tokenType } };
        await expect(g.canActivate(ctx(req))).rejects.toBeInstanceOf(ForbiddenException);
      }
    } finally { spy.mockRestore(); }
  });
});

describe('manager-PIN gate for devices (reports, audit log)', () => {
  const mgrJwt = (s: Seed, over: any = {}) => jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee', iatMs: Date.now(), ...over }, 'test-secret', { expiresIn: '1h', jwtid: new Types.ObjectId().toString() });
  const gated = () => { class C { @RequireManagerPin() m() {} } return new C().m; };
  it('metadata flag is set by @RequireManagerPin', () => {
    expect(Reflect.getMetadata(REQUIRE_MANAGER_PIN, gated())).toBe(true);
  });

  it('device without a manager session → MANAGER_PIN_REQUIRED; cashier session too; manager session passes; revoked manager session fails', async () => {
    const s = await seedStore(h);
    const d = await registerDevice(s);
    const call = (headers: any) => makeGuard().canActivate(ctx(request(d.deviceToken, { headers }), gated()));
    expect(await codeOf(call({}))).toBe('MANAGER_PIN_REQUIRED');
    const cashier = jwt.sign({ employeeId: s.cashierId, storeId: s.storeId, role: 'cashier', type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
    expect(await codeOf(call({ 'x-pos-employee-token': cashier }))).toBe('MANAGER_PIN_REQUIRED');
    const mgr = mgrJwt(s);
    expect(await call({ 'x-pos-employee-token': mgr })).toBe(true);
    await revocations.revokeToken((jwt.decode(mgr) as any).jti);
    expect(await codeOf(call({ 'x-pos-employee-token': mgr }))).toBe('MANAGER_PIN_REQUIRED');
    // a manager of ANOTHER store does not count
    const other = await seedStore(h);
    expect(await codeOf(call({ 'x-pos-employee-token': mgrJwt(other) }))).toBe('MANAGER_PIN_REQUIRED');
  });
});

describe('employee-token revocation (Redis)', () => {
  const setPin = async (s: Seed, who: 'manager' | 'cashier', pin = '1234') => {
    const id = who === 'manager' ? s.managerId : s.cashierId;
    await h.repos.employeeModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { pin: await bcrypt.hash(pin, 4), status: 'active', sellerId: s.sellerId } });
  };
  const login = async (svc: PosService, s: Seed, who: 'manager' | 'cashier', pin = '1234', deviceId: string | null = null) =>
    (await svc.pinLogin({ storeId: s.storeId, email: who === 'manager' ? 'm@x.com' : 'c@x.com', pin } as any, { userId: s.sellerId, role: 'seller', deviceId })).data.employeeToken as string;
  const open = async (svc: PosService, s: Seed) => (await svc.openSession(s.sellerId, { storeId: s.storeId, registerId: s.registerId, employeeId: s.cashierId, openingCash: 0 } as any) as any).data._id as string;
  const discountSale = (svc: PosService, s: Seed, sid: string, token: string) => svc.createSale(s.sellerId, { storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], paymentMethod: 'cash', discountType: 'percent', discountValue: 10 } as any, token);

  it('pin-logout revokes THAT token server-side (not just on the device); the employee\'s other session is untouched', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    await setPin(s, 'manager');
    const sid = await open(svc, s);
    const t1 = await login(svc, s, 'manager');
    const t2 = await login(svc, s, 'manager');
    await expect(discountSale(svc, s, sid, t1)).resolves.toBeTruthy();
    await svc.pinLogout(s.sellerId, s.storeId, t1);
    await expect(discountSale(svc, s, sid, t1)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(discountSale(svc, s, sid, t2)).resolves.toBeTruthy();
  });

  it('PIN reset and deactivation kill every token issued before; a fresh login afterwards works (PIN reset)', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    await setPin(s, 'manager');
    const sid = await open(svc, s);
    const old = await login(svc, s, 'manager');
    await svc.resetPin(s.sellerId, s.storeId, s.managerId, { newPin: '9876' } as any);
    await expect(discountSale(svc, s, sid, old)).rejects.toBeInstanceOf(ForbiddenException);
    const fresh = await login(svc, s, 'manager', '9876');
    await expect(discountSale(svc, s, sid, fresh)).resolves.toBeTruthy();

    await svc.removeEmployeeV2(s.sellerId, s.storeId, s.managerId);
    await expect(discountSale(svc, s, sid, fresh)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a lockout (5 wrong PINs) also ends sessions opened before it', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    await setPin(s, 'manager');
    const sid = await open(svc, s);
    const t = await login(svc, s, 'manager');
    for (let i = 0; i < 5; i++) await expect(login(svc, s, 'manager', '0000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(discountSale(svc, s, sid, t)).rejects.toBeInstanceOf(ForbiddenException);
    // …and the lock holds with the RIGHT pin, from another device too (no side door around it)
    await expect(login(svc, s, 'manager', '1234', 'another-device')).rejects.toThrow(/Too many failed PIN attempts/);
  });

  it('owner unlock: lifts a PIN lockout WITHOUT changing the PIN, is audited, belongs to the owner only, and the lock can come back', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    await setPin(s, 'manager');
    for (let i = 0; i < 5; i++) await expect(login(svc, s, 'manager', '0000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(login(svc, s, 'manager', '1234')).rejects.toThrow(/Too many failed PIN attempts/);
    // another owner cannot unlock this store's employee
    await expect(svc.unlockPin(new Types.ObjectId().toString(), s.storeId, s.managerId)).rejects.toBeInstanceOf(ForbiddenException);
    const r = await svc.unlockPin(s.sellerId, s.storeId, s.managerId);
    expect(r.data.wasLocked).toBe(true);
    await expect(login(svc, s, 'manager', '1234')).resolves.toBeTruthy(); // the SAME pin works again
    const audit = await h.repos.posAuditLogModel.find({ storeId: s.storeId, action: 'employee_pin_unlocked' }).lean();
    expect(audit).toHaveLength(1);
    // unlocking a person who is not locked is harmless and says so
    expect((await svc.unlockPin(s.sellerId, s.storeId, s.managerId)).data.wasLocked).toBe(false);
    // five more wrong PINs lock again (the counter really restarted)
    for (let i = 0; i < 5; i++) await expect(login(svc, s, 'manager', '0000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(login(svc, s, 'manager', '1234')).rejects.toThrow(/Too many failed PIN attempts/);
  });

  it('offline replay: a revocation counts only if it had already happened when the sale was made', async () => {
    const s = await seedStore(h);
    const jti = new Types.ObjectId().toString();
    const payload = { jti, employeeId: s.managerId, iat: Math.floor((Date.now() - 3 * HOUR) / 1000), iatMs: Date.now() - 3 * HOUR };
    await revocations.revokeToken(jti); // logged out "now"
    expect(await revocations.isRevoked(payload, new Date(Date.now() - 1 * HOUR))).toBe(false); // sale made BEFORE the logout → approval stands
    expect(await revocations.isRevoked(payload, new Date(Date.now() + 60_000))).toBe(true);    // sale made AFTER the logout → refused
    expect(await revocations.isRevoked(payload)).toBe(true);                                    // online use → refused
  });

  it('end to end: an offline discount approved by a manager who has since logged out / been deactivated is still accepted', async () => {
    const svc = makeService();
    const s = await seedStore(h, { stock: 10, price: 100 });
    await setPin(s, 'manager');
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ employeeId: s.managerId, storeId: s.storeId, role: 'manager', type: 'pos_employee', iat: now - 2 * 3600, iatMs: Date.now() - 2 * HOUR }, 'test-secret', { expiresIn: '12h', jwtid: new Types.ObjectId().toString() });
    const sid = await open(svc, s);
    await h.repos.registerSessionModel.collection.updateOne({ _id: new Types.ObjectId(sid) }, { $set: { openedAt: new Date(Date.now() - 5 * HOUR) } });
    await svc.pinLogout(s.sellerId, s.storeId, token);
    await svc.removeEmployeeV2(s.sellerId, s.storeId, s.managerId);
    const res: any = await svc.createSale(s.sellerId, {
      storeId: s.storeId, sessionId: sid, registerId: s.registerId, employeeId: s.cashierId, paymentMethod: 'cash', discountType: 'percent', discountValue: 10,
      items: [{ productId: s.productId, variantId: s.variantId, qty: 1 }], offline: true, clientCreatedAt: new Date(Date.now() - HOUR).toISOString(),
    } as any, token);
    expect(res.data.status).toBe('completed');
    expect(res.data.approvedBy).toBe(s.managerId);
  });
});

describe('per-device PIN rate limiting', () => {
  it('after too many wrong PINs the DEVICE is refused (429) even with a right PIN; other devices are unaffected; success resets', async () => {
    const svc = makeService();
    const s = await seedStore(h);
    await h.repos.employeeModel.collection.updateOne({ _id: new Types.ObjectId(s.cashierId) }, { $set: { pin: await bcrypt.hash('1234', 4), status: 'active', sellerId: s.sellerId } });
    const dev = `dev-${new Types.ObjectId()}`;
    const attempt = (email: string, pin: string, deviceId: string) => svc.pinLogin({ storeId: s.storeId, email, pin } as any, { userId: s.sellerId, role: 'seller', deviceId });
    // guessing across non-existent accounts doesn't trip any per-employee lock — the device limiter is what stops it
    for (let i = 0; i < PosTokenRevocationService.PIN_MAX_FAILURES; i++) await expect(attempt(`nobody${i}@x.com`, '1111', dev)).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt('c@x.com', '1234', dev)).rejects.toMatchObject({ status: 429, response: { code: 'POS_PIN_RATE_LIMITED' } });
    await expect(attempt('c@x.com', '1234', `${dev}-other`)).resolves.toMatchObject({ success: true });

    // a few typos then a correct PIN: fine, and the counter resets
    const dev2 = `dev-${new Types.ObjectId()}`;
    for (let i = 0; i < 5; i++) await expect(attempt('nobody@x.com', '1111', dev2)).rejects.toBeInstanceOf(BadRequestException);
    await expect(attempt('c@x.com', '1234', dev2)).resolves.toMatchObject({ success: true });
    expect(await revocations.pinRetryAfter(`dev:${dev2}:${s.storeId}`)).toBe(0);
    expect(Number(await redis.get(`pos:pin-rl:dev:${dev2}:${s.storeId}`) ?? 0)).toBe(0);
  });
});

describe('device self sign-out', () => {
  it('retires its own token (and the guard then refuses it)', async () => {
    const s = await seedStore(h);
    const d = await registerDevice(s);
    await devices.signOutSelf(d.deviceId, s.storeId);
    expect(await codeOf(makeGuard().canActivate(ctx(request(d.deviceToken))))).toBe('POS_DEVICE_REVOKED');
    expect(await h.repos.posAuditLogModel.countDocuments({ action: 'device_signed_out' })).toBe(1);
  });
});

describe('legacy auth sunset (POS_LEGACY_AUTH_ALLOWED)', () => {
  afterEach(() => { delete process.env.POS_LEGACY_AUTH_ALLOWED; });
  const withOwnerJwt = async (fn: () => Promise<any>) => {
    const spy = jest.spyOn(JwtAuthGuard.prototype, 'canActivate').mockResolvedValue(true);
    try { return await fn(); } finally { spy.mockRestore(); }
  };
  const ownerJwt = () => jwt.sign({ sub: 'seller-1', role: 'seller' }, 'test-secret');

  it('default (true): an owner JWT still passes the POS guard', async () => {
    expect(await withOwnerJwt(() => makeGuard().canActivate(ctx(request(ownerJwt()))))).toBe(true);
  });

  it('false: an owner/staff JWT gets POS_LEGACY_AUTH_DISABLED (403); a device token is unaffected', async () => {
    process.env.POS_LEGACY_AUTH_ALLOWED = 'false';
    const err: any = await withOwnerJwt(async () => { try { await makeGuard().canActivate(ctx(request(ownerJwt()))); } catch (e) { return e; } });
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse().code).toBe('POS_LEGACY_AUTH_DISABLED');
    const s = await seedStore(h);
    const d = await registerDevice(s);
    expect(await makeGuard().canActivate(ctx(request(d.deviceToken)))).toBe(true);
  });

  it('owner-only routes (JwtAuthGuard) are NOT affected by the flag — registration and revoke still work for the owner', async () => {
    process.env.POS_LEGACY_AUTH_ALLOWED = 'false';
    const s = await seedStore(h);
    await expect(devices.register(s.sellerId, { storeId: s.storeId, registerId: s.registerId, name: 'x' })).resolves.toBeTruthy();
  });
});
