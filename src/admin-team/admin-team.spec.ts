import { ForbiddenException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';
import { ADMIN_APPROVAL_KEY, ADMIN_SELF_KEY } from '../auth/decorators/admin-guards.decorator';
import { AdminSecurityService } from '../auth/admin-security.service';
import { AdminTeamService } from './admin-team.service';
import { ADMIN_PERMISSIONS } from './admin-permissions';

// ── tiny in-memory model helpers ─────────────────────────────────────────────
const lean = (v: any) => ({ lean: async () => v, select: () => ({ lean: async () => v }), then: (r: any) => r(v) });

describe('PermissionsGuard — platform admin team', () => {
  const makeGuard = (meta: Record<string, any>, approvals: any[] = []) => {
    const reflector: any = { getAllAndOverride: jest.fn((key: string) => meta[key]) };
    const approvalModel: any = {
      findOneAndUpdate: jest.fn(async (filter: any) => {
        const hit = approvals.find((a) => a.requestedBy === filter.requestedBy && a.action === filter.action && a.status === 'approved');
        if (hit) hit.status = 'used';
        return hit ?? null;
      }),
      findOne: jest.fn(() => lean(approvals.find((a) => a.status === 'pending') ?? null)),
      create: jest.fn(async (d: any) => { approvals.push({ ...d, status: 'pending' }); }),
    };
    const db: any = { repositories: { adminApprovalModel: approvalModel, adminModel: { findById: () => lean({ name: 'Fin' }) } } };
    const guard = new PermissionsGuard(reflector, db);
    const run = (user: any, method = 'GET') => guard.canActivate({
      getHandler: () => null, getClass: () => null,
      switchToHttp: () => ({ getRequest: () => ({ user, method, params: {}, query: {}, body: {}, route: { path: '/api/admin/x' }, path: '/api/admin/x' }) }),
    } as any);
    return { run, approvals };
  };
  const team = (permissions: string[], extra: any = {}) => ({ role: 'admin', userId: 'a1', teamAdmin: true, permissions, ...extra });

  it('the owner / a Super Admin (no team claim) is never restricted', async () => {
    const { run } = makeGuard({ [REQUIRE_PERMISSION_KEY]: ['finance.payouts'] });
    await expect(run({ role: 'admin', userId: 'o1' }, 'POST')).resolves.toBe(true);
  });

  it('a team admin passes only with a listed permission', async () => {
    const { run } = makeGuard({ [REQUIRE_PERMISSION_KEY]: ['finance.view'] });
    await expect(run(team(['finance.view']))).resolves.toBe(true);
    await expect(run(team(['clients.view']))).rejects.toThrow(/doesn't have permission/);
  });

  it('fails closed: a route that names no permission is not open to a team admin', async () => {
    const { run } = makeGuard({});
    await expect(run(team(['finance.view']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a read-only role can look but never change', async () => {
    const { run } = makeGuard({ [REQUIRE_PERMISSION_KEY]: ['finance.view'] });
    await expect(run(team(['finance.view'], { readOnly: true }), 'GET')).resolves.toBe(true);
    await expect(run(team(['finance.view'], { readOnly: true }), 'PATCH')).rejects.toThrow(/read-only/);
  });

  it('@AdminSelf routes (own sessions) need no team permission', async () => {
    const { run } = makeGuard({ [ADMIN_SELF_KEY]: true });
    await expect(run(team([]))).resolves.toBe(true);
  });

  it('an approval-gated action is refused, queued once, then allowed exactly once after the Super Admin approves', async () => {
    const approvals: any[] = [];
    const { run } = makeGuard({ [REQUIRE_PERMISSION_KEY]: ['finance.payouts'], [ADMIN_APPROVAL_KEY]: 'payout.manual' }, approvals);
    await expect(run(team(['finance.payouts']), 'POST')).rejects.toThrow(/needs the Super Admin's approval/);
    await expect(run(team(['finance.payouts']), 'POST')).rejects.toThrow(/approval/);
    expect(approvals.length).toBe(1); // not duplicated
    approvals[0].status = 'approved';
    approvals[0].requestedBy = 'a1';
    await expect(run(team(['finance.payouts']), 'POST')).resolves.toBe(true);
    expect(approvals[0].status).toBe('used');
    await expect(run(team(['finance.payouts']), 'POST')).rejects.toThrow(/approval/); // single use
  });

  it('a "view as store" token can read but never write', async () => {
    const { run } = makeGuard({});
    const view = { role: 'staff', userId: 'a1', storeId: 'S1', permissions: [], viewOnly: true };
    await expect(run(view, 'POST')).rejects.toThrow(/read-only/);
  });
});

describe('AdminSecurityService', () => {
  const setup = (admin: any = {}) => {
    const updates: any[] = [];
    const notify = jest.fn(async () => undefined);
    const adminModel: any = {
      findByIdAndUpdate: jest.fn(() => lean({ failedLoginCount: (admin.failedLoginCount ?? 0) + 1 })),
      updateOne: jest.fn(async (...a: any[]) => { updates.push(a); }),
      find: jest.fn(() => lean([{ _id: 'sup1' }])),
      findOne: jest.fn(() => lean(admin.sessionAdmin ?? null)),
    };
    const roleModel: any = { findOne: jest.fn(() => lean({ permissions: ['finance.view'], readOnly: true })) };
    const svc = new AdminSecurityService({ repositories: { adminModel, adminRoleModel: roleModel } } as any, { notify } as any);
    return { svc, updates, notify, adminModel };
  };

  it('locks after the 5th wrong password and refuses even the right one while locked', async () => {
    const { svc, updates } = setup({ failedLoginCount: 4 });
    await svc.recordFailure({ _id: 'a1' });
    expect(updates.some((u) => u[1].$set?.lockedUntil)).toBe(true);
    expect(() => svc.assertCanAttempt({ lockedUntil: new Date(Date.now() + 5 * 60000) })).toThrow(/Too many failed attempts/);
  });

  it("an invite that hasn't been accepted cannot sign in", () => {
    const { svc } = setup();
    expect(() => svc.assertCanAttempt({ inviteSentAt: new Date(), isVerified: false })).toThrow(/hasn't been accepted/);
  });

  it('a team admin gets permission + read-only claims and a session id; a Super Admin gets only a session id', async () => {
    const { svc } = setup();
    const team = await svc.onSuccess({ _id: 'a1', roleId: 'r1', isSuperAdmin: false, sessions: [], knownDevices: [] }, '1.1.1.1', 'UA');
    expect(team).toMatchObject({ teamAdmin: true, permissions: ['finance.view'], readOnly: true });
    expect(team.sid).toBeTruthy();
    const owner = await svc.onSuccess({ _id: 'o1', isSuperAdmin: true, sessions: [], knownDevices: [] }, '1.1.1.1', 'UA');
    expect(owner).toEqual({ sid: expect.any(String) });
  });

  it('temporary access that has ended cannot sign in', async () => {
    const { svc } = setup();
    await expect(svc.onSuccess({ _id: 'a1', roleId: 'r1', accessExpiresAt: new Date(Date.now() - 1000), sessions: [], knownDevices: [] })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('alerts Super Admins on a NEW device, but not on the very first login and not on a known device', async () => {
    const first = setup();
    await first.svc.onSuccess({ _id: 'a1', roleId: 'r1', sessions: [], knownDevices: [] }, '1.1.1.1', 'UA');
    expect(first.notify).not.toHaveBeenCalled();
    const second = setup();
    await second.svc.onSuccess({ _id: 'a1', name: 'Fin', roleId: 'r1', sessions: [], knownDevices: ['someotherdevice000000000'] }, '9.9.9.9', 'New Browser');
    await new Promise((r) => setImmediate(r));
    expect(second.notify).toHaveBeenCalledTimes(1);
  });

  it('a revoked session id is rejected', async () => {
    const { svc } = setup({ sessionAdmin: null });
    await expect(svc.assertSessionActive('a1', 'gone')).rejects.toThrow(/Session revoked/);
  });
});

describe('AdminTeamService rules', () => {
  const makeSvc = (opts: { supers?: number; target?: any; role?: any } = {}) => {
    const target = opts.target ?? { _id: 't1', name: 'T', email: 't@x.co', isSuperAdmin: false, roleId: 'r1', status: 'active', sessions: [], save: jest.fn() };
    const adminModel: any = {
      findOne: jest.fn(() => (Promise.resolve(target) as any)),
      countDocuments: jest.fn(async () => opts.supers ?? 1),
      exists: jest.fn(async () => null),
      create: jest.fn(async (d: any) => ({ ...d, _id: 'new1', toObject: () => ({ ...d, _id: 'new1' }) })),
      findById: jest.fn(() => lean({ name: 'Owner', email: 'o@x.co' })),
      deleteOne: jest.fn(async () => ({})),
    };
    const roleModel: any = { findOne: jest.fn(() => lean(opts.role ?? { permissions: ['finance.view'], name: 'Finance' })), exists: jest.fn(async () => null), create: jest.fn(async (d: any) => ({ ...d, _id: 'r9' })) };
    const approvalModel: any = { findOneAndUpdate: jest.fn(async () => ({ _id: 'ap1', summary: 'x', requestedByName: 'Fin' })) };
    const email = { sendMail: jest.fn(async () => true) };
    const jwt = { sign: jest.fn(() => 'view.tok') };
    const redis = { set: jest.fn() };
    const activity = { log: jest.fn() };
    const storeModel: any = { findById: () => lean({ _id: 'S1', name: 'Shop', sellerId: 'sel1', isDelete: false }) };
    const svc = new AdminTeamService({ repositories: { adminModel, adminRoleModel: roleModel, adminApprovalModel: approvalModel, storeModel } } as any, jwt as any, redis as any, activity as any, email as any);
    return { svc, target, adminModel, jwt, email };
  };
  const owner = { userId: 'o1' };
  const teamMgr = { userId: 'm1', teamAdmin: true, permissions: ['team.manage', 'finance.view'] };

  it('knows every admin permission key', () => {
    expect(ADMIN_PERMISSIONS.length).toBeGreaterThanOrEqual(18);
    expect(new Set(ADMIN_PERMISSIONS).size).toBe(ADMIN_PERMISSIONS.length);
  });

  it('invite emails the link; only a Super Admin gets the raw link back', async () => {
    const { svc, email } = makeSvc();
    const res: any = await svc.invite(owner, { name: 'N', email: 'N@X.co', roleId: 'r1' });
    expect(email.sendMail).toHaveBeenCalled();
    expect(res.inviteUrl).toMatch(/\/admin-invite\/[a-f0-9]+$/);
    const t: any = await svc.invite(teamMgr, { name: 'N', email: 'n2@x.co', roleId: 'r1' });
    expect(t.inviteUrl).toBeUndefined();
  });

  it("a team manager can't hand out a role with permissions it doesn't hold", async () => {
    const { svc } = makeSvc({ role: { permissions: ['finance.payouts'], name: 'Pay' } });
    await expect(svc.invite(teamMgr, { name: 'N', email: 'n@x.co', roleId: 'r1' })).rejects.toThrow(/can't grant permissions/);
  });

  it('nobody can change their own role/status, and a team manager cannot touch a Super Admin', async () => {
    const { svc, target } = makeSvc();
    await expect(svc.update({ userId: 't1' }, 't1', { status: 'inactive' })).rejects.toThrow(/your own/);
    target.isSuperAdmin = true;
    await expect(svc.update(teamMgr, 't1', { name: 'x' })).rejects.toThrow(/Only a Super Admin/);
  });

  it('the last Super Admin cannot be demoted, deactivated or deleted', async () => {
    const { svc, target } = makeSvc({ supers: 0 });
    target.isSuperAdmin = true;
    await expect(svc.setSuper(owner, 't1', false)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update(owner, 't1', { status: 'inactive' })).rejects.toThrow(/last Super Admin/);
    await expect(svc.remove(owner, 't1')).rejects.toThrow(/last Super Admin/);
  });

  it('only a Super Admin can approve, promote or delete', async () => {
    const { svc } = makeSvc();
    await expect(svc.decide(teamMgr, 'ap1', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.setSuper(teamMgr, 't1', true)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.remove(teamMgr, 't1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.decide(owner, 'ap1', true)).resolves.toMatchObject({ success: true });
  });

  it('"view as store" issues a short-lived staff-shaped token that is marked view-only', async () => {
    const { svc, jwt } = makeSvc();
    const res: any = await svc.viewAsStore(owner, 'S1');
    const payload = (jwt.sign as jest.Mock).mock.calls[0][0];
    expect(payload).toMatchObject({ role: 'staff', storeId: 'S1', sellerId: 'sel1', viewOnly: true, viewAs: 'o1' });
    expect((jwt.sign as jest.Mock).mock.calls[0][1]).toEqual({ expiresIn: '30m' });
    expect(res.data.accessToken).toBe('view.tok');
  });
});
