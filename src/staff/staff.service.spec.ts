import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { StaffService } from './staff.service';
import { RoleService } from './role.service';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const chain = (v: any) => ({ select: () => ({ lean: async () => v, then: (r: any) => r(v) }), lean: async () => v });

function makeService(over: { staff?: any; role?: any; owner?: any } = {}) {
  const staffDoc = over.staff;
  const staffMemberModel: any = {
    findOne: jest.fn(() => ({ select: async () => staffDoc, then: (r: any) => r(staffDoc) })),
    findById: jest.fn(() => chain(staffDoc)),
    findByIdAndUpdate: jest.fn(() => chain({ failedLoginCount: (staffDoc?.failedLoginCount ?? 0) + 1 })),
    updateOne: jest.fn(async () => ({})),
    deleteOne: jest.fn(async () => ({})),
  };
  const roleModel: any = { findOne: jest.fn(() => chain(over.role ?? { permissions: ['orders.view'] })) };
  const sellerModel: any = { findById: jest.fn(() => chain(over.owner ?? { status: 'active', isDelete: false })) };
  const storeModel: any = { findById: jest.fn(() => chain({ name: 'Shop', contactEmail: null })) };
  const db: any = { repositories: { staffMemberModel, roleModel, sellerModel, storeModel } };
  const jwt: any = { sign: jest.fn(() => 'tok') };
  const redis: any = { set: jest.fn(), del: jest.fn() };
  const activity: any = { log: jest.fn() };
  const email: any = { sendMail: jest.fn(async () => true) };
  const entitlements: any = { assertCanAddStaff: jest.fn() };
  return { svc: new StaffService(db, jwt, redis, activity, email, entitlements), staffMemberModel, email, redis, jwt };
}

describe('StaffService login lockout', () => {
  it('locks the account after the 5th wrong password', async () => {
    const staff = { _id: 's1', status: 'active', sellerId: 'o', passwordHash: await bcrypt.hash('right-pass-1', 4), failedLoginCount: 4, lockedUntil: null };
    const { svc, staffMemberModel } = makeService({ staff });
    staffMemberModel.findByIdAndUpdate.mockReturnValue(chain({ failedLoginCount: 5 }));
    await expect(svc.login('st', 'a@b.co', 'wrong')).rejects.toThrow('Invalid email or password');
    const lockCall = staffMemberModel.updateOne.mock.calls.find((c: any[]) => c[1].$set.lockedUntil);
    expect(lockCall).toBeTruthy();
    expect(lockCall[1].$set.lockedUntil.getTime()).toBeGreaterThan(Date.now() + 14 * 60000);
  });

  it('rejects even the right password while locked', async () => {
    const staff = { _id: 's1', status: 'active', sellerId: 'o', passwordHash: await bcrypt.hash('right-pass-1', 4), lockedUntil: new Date(Date.now() + 5 * 60000) };
    const { svc } = makeService({ staff });
    await expect(svc.login('st', 'a@b.co', 'right-pass-1')).rejects.toThrow(/Too many failed attempts/);
  });

  it('clears the failure counter on a good login', async () => {
    const staff = { _id: 's1', email: 'a@b.co', name: 'A', status: 'active', sellerId: 'o', roleId: 'r', passwordHash: await bcrypt.hash('right-pass-1', 4), failedLoginCount: 3, lockedUntil: null };
    const { svc, staffMemberModel } = makeService({ staff });
    const res = await svc.login('st', 'a@b.co', 'right-pass-1');
    expect(res.data.accessToken).toBe('tok');
    expect(staffMemberModel.updateOne).toHaveBeenCalledWith({ _id: 's1' }, { $set: { failedLoginCount: 0, lockedUntil: null } });
  });
});

describe('StaffService own account + reset', () => {
  it('changeOwnPassword rejects a wrong current password and bumps tokenVersion on success', async () => {
    const save = jest.fn();
    const staff: any = { _id: 's1', storeId: 'st', sellerId: 'o', roleId: null, tokenVersion: 2, passwordHash: await bcrypt.hash('old-pass-1', 4), save };
    const { svc } = makeService({ staff });
    await expect(svc.changeOwnPassword('s1', 'nope', 'new-pass-123')).rejects.toThrow('Current password is incorrect');
    const res = await svc.changeOwnPassword('s1', 'old-pass-1', 'new-pass-123', 'oldtok');
    expect(staff.tokenVersion).toBe(3);
    expect(await bcrypt.compare('new-pass-123', staff.passwordHash)).toBe(true);
    expect(res.data.accessToken).toBe('tok');
  });

  it('forgotPassword answers identically for unknown emails and sends nothing', async () => {
    const { svc, email } = makeService({ staff: null });
    const res = await svc.forgotPassword('st', 'ghost@x.co');
    expect(res.success).toBe(true);
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('forgotPassword stores only a hash of the emailed token', async () => {
    const save = jest.fn();
    const staff: any = { _id: 's1', name: 'A', email: 'a@b.co', passwordHash: 'x', save };
    const { svc, email } = makeService({ staff });
    await svc.forgotPassword('st', 'a@b.co');
    const html: string = email.sendMail.mock.calls[0][2];
    const token = /staff-reset-password\/([a-f0-9]+)/.exec(html)![1];
    expect(staff.resetTokenHash).toBe(sha(token));
    expect(staff.resetTokenHash).not.toBe(token);
  });

  it('resetPassword rejects expired tokens and revokes sessions on success', async () => {
    const expired: any = { resetTokenExpiresAt: new Date(Date.now() - 1000), save: jest.fn() };
    await expect(makeService({ staff: expired }).svc.resetPassword('t', 'brand-new-1')).rejects.toThrow(/invalid or has expired/);
    const ok: any = { storeId: 'st', tokenVersion: 1, resetTokenExpiresAt: new Date(Date.now() + 60000), save: jest.fn() };
    await makeService({ staff: ok }).svc.resetPassword('t', 'brand-new-1');
    expect(ok.tokenVersion).toBe(2);
    expect(ok.resetTokenHash).toBeNull();
    expect(ok.lockedUntil).toBeNull();
  });
});

describe('StaffService privilege rules', () => {
  it("a staff manager cannot delete themselves or a colleague with a stronger role", async () => {
    const target: any = { _id: 'other', name: 'Boss', roleId: 'rb' };
    const { svc } = makeService({ staff: target, role: { permissions: ['orders.view', 'finance.payouts.view'] } });
    await expect(svc.remove('me', 'staff', ['staff.manage'], 'st', 'me')).rejects.toThrow(/own account/);
    await expect(svc.remove('me', 'staff', ['staff.manage', 'orders.view'], 'st', 'other')).rejects.toThrow(/more access than yours/);
  });

  it('a seller can delete staff (hard delete)', async () => {
    const target: any = { _id: 'other', name: 'X', roleId: null };
    const { svc, staffMemberModel } = makeService({ staff: target });
    (svc as any).verifyStoreOwnership = jest.fn();
    await svc.remove('seller1', 'seller', null, 'st', 'other');
    expect(staffMemberModel.deleteOne).toHaveBeenCalledWith({ _id: 'other', storeId: 'st' });
  });
});

describe('RoleService escalation guard', () => {
  const makeRoles = (existing: string[] = ['orders.view']) => {
    const role: any = { permissions: existing, isPreset: false, save: jest.fn(), toObject: () => ({}) };
    const roleModel: any = { findOne: jest.fn(async () => role), create: jest.fn(async (d: any) => d), find: jest.fn() };
    const staffMemberModel: any = { updateMany: jest.fn(), countDocuments: jest.fn(async () => 0) };
    return { svc: new RoleService({ repositories: { roleModel, staffMemberModel, storeModel: {} } } as any), roleModel, role };
  };

  it('staff cannot create a role with permissions they do not hold', async () => {
    const { svc } = makeRoles();
    await expect(svc.create('me', 'staff', 'st', { name: 'Root', permissions: ['finance.payouts.view'] } as any, ['staff.manage'])).rejects.toThrow(/don't have/);
    await expect(svc.create('me', 'staff', 'st', { name: 'Ok', permissions: ['orders.view'] } as any, ['staff.manage', 'orders.view'])).resolves.toBeTruthy();
  });

  it('staff cannot widen a role (their own or another)', async () => {
    const { svc } = makeRoles(['orders.view']);
    await expect(svc.update('me', 'staff', 'st', 'r', { permissions: ['orders.view', 'products.delete'] } as any, ['staff.manage', 'orders.view'])).rejects.toThrow(/don't have/);
  });

  it('staff cannot edit or delete a role stronger than themselves', async () => {
    const { svc } = makeRoles(['finance.payouts.view']);
    await expect(svc.update('me', 'staff', 'st', 'r', { name: 'x' } as any, ['staff.manage'])).rejects.toThrow(/don't have/);
    await expect(svc.remove('me', 'staff', 'st', 'r', ['staff.manage'])).rejects.toThrow(/don't have/);
  });

  it('a seller is never restricted', async () => {
    const { svc } = makeRoles(['finance.payouts.view']);
    (svc as any).verifyStoreOwnership = jest.fn();
    await expect(svc.update('o', 'seller', 'st', 'r', { permissions: ['products.delete'] } as any)).resolves.toBeTruthy();
  });
});

describe('StaffService invite delivery feedback', () => {
  const setup = (mailOk: boolean) => {
    const made: any = { _id: 'n1', name: 'New', toObject: () => ({ _id: 'n1', name: 'New', passwordHash: 'x', inviteToken: 'y' }) };
    const ctx = makeService({ staff: null });
    (ctx.staffMemberModel as any).findOne = jest.fn(async () => null);
    (ctx.staffMemberModel as any).create = jest.fn(async () => made);
    (ctx.email.sendMail as jest.Mock).mockResolvedValue(mailOk);
    (ctx.svc as any).verifyStoreOwnership = jest.fn();
    return ctx;
  };

  it('reports emailSent=false when SMTP fails, and still hands the owner the link', async () => {
    const { svc } = setup(false);
    const res: any = await svc.create('owner', 'seller', null, 'st', { name: 'New', email: 'n@x.co' } as any);
    expect(res.emailSent).toBe(false);
    expect(res.inviteUrl).toMatch(/\/staff-invite\/[a-f0-9]+$/);
    expect(res.data.passwordHash).toBeUndefined();
    expect(res.data.inviteToken).toBeUndefined();
  });

  it('never exposes the invite link to a staff manager (it is a credential)', async () => {
    const { svc } = setup(true);
    const res: any = await svc.create('mgr', 'staff', ['staff.manage'], 'st', { name: 'New', email: 'n@x.co' } as any);
    expect(res.emailSent).toBe(true);
    expect(res.inviteUrl).toBeUndefined();
  });
});

describe('StaffService retired permissions', () => {
  it('drops permission keys that no longer exist from a role before issuing them', async () => {
    const staff = { _id: 's1', email: 'a@b.co', name: 'A', status: 'active', sellerId: 'o', roleId: 'r', passwordHash: await bcrypt.hash('right-pass-1', 4) };
    const { svc, jwt } = makeService({ staff, role: { permissions: ['orders.view', 'subscriptions.view', 'subscriptions.manage'] } });
    const res = await svc.login('st', 'a@b.co', 'right-pass-1');
    expect(res.data.staff.permissions).toEqual(['orders.view']);
    expect((jwt.sign as jest.Mock).mock.calls[0][0].permissions).toEqual(['orders.view']);
  });
});

describe('RoleService retired permission cleanup', () => {
  it('strips retired keys from stored roles when listing, so a later Save validates', async () => {
    const roles: any[] = [{ _id: 'r1', name: 'Store Manager', permissions: ['orders.view', 'subscriptions.view', 'subscriptions.manage'] }, { _id: 'r2', name: 'Ok', permissions: ['orders.view'] }];
    const roleModel: any = {
      find: jest.fn(() => ({ select: () => ({ lean: async () => roles.map((r) => ({ name: r.name })) }), sort: () => ({ lean: async () => roles }) })),
      insertMany: jest.fn(),
      updateOne: jest.fn(async () => ({})),
    };
    const svc = new RoleService({ repositories: { roleModel, storeModel: {}, staffMemberModel: {} } } as any);
    (svc as any).verifyStoreOwnership = jest.fn();
    const res: any = await svc.list('o', 'seller', 'st');
    expect(res.data[0].permissions).toEqual(['orders.view']);
    expect(roleModel.updateOne).toHaveBeenCalledTimes(1);
    expect(roleModel.updateOne).toHaveBeenCalledWith({ _id: 'r1' }, { $set: { permissions: ['orders.view'] } });
  });
});

describe('StaffService own profile (phone + photo)', () => {
  const setup = () => {
    const ctx = makeService({ staff: { _id: 's1', name: 'A', email: 'a@b.co', storeId: 'st', roleId: null, inviteAcceptedAt: new Date() } });
    (ctx.staffMemberModel as any).findOneAndUpdate = jest.fn(async () => ({ _id: 's1' }));
    return ctx;
  };

  it('changes only the fields that were sent, and clears with an empty string', async () => {
    const { svc, staffMemberModel } = setup();
    await svc.updateOwnProfile('s1', { phone: ' +92 300 1234567 ', profileImage: 'https://img.example/p.jpg' });
    expect((staffMemberModel.findOneAndUpdate as jest.Mock).mock.calls[0][1]).toEqual({ $set: { phone: '+92 300 1234567', profileImage: 'https://img.example/p.jpg' } });
    await svc.updateOwnProfile('s1', { phone: '', profileImage: '' });
    expect((staffMemberModel.findOneAndUpdate as jest.Mock).mock.calls[1][1]).toEqual({ $set: { phone: null, profileImage: null } });
  });

  it('rejects a blank name and an empty update; never touches email/role/permissions', async () => {
    const { svc, staffMemberModel } = setup();
    await expect(svc.updateOwnProfile('s1', { name: '   ' })).rejects.toThrow('Name is required');
    await expect(svc.updateOwnProfile('s1', {})).rejects.toThrow('Nothing to update');
    await svc.updateOwnProfile('s1', { name: 'New Name', ...({ email: 'x@y.co', roleId: 'r', permissions: ['staff.manage'] } as any) });
    const set = (staffMemberModel.findOneAndUpdate as jest.Mock).mock.calls[0][1].$set;
    expect(Object.keys(set)).toEqual(['name']);
  });
});

describe('RoleService preset upgrade', () => {
  const setup = (rows: any[]) => {
    const roleModel: any = {
      find: jest.fn(() => ({ select: () => ({ lean: async () => rows }), sort: () => ({ lean: async () => rows }) })),
      insertMany: jest.fn(),
      updateOne: jest.fn(async () => ({})),
    };
    const staffMemberModel: any = { updateMany: jest.fn(async () => ({})) };
    const svc = new RoleService({ repositories: { roleModel, staffMemberModel, storeModel: {} } } as any);
    (svc as any).verifyStoreOwnership = jest.fn();
    return { svc, roleModel, staffMemberModel };
  };
  const presets = (version: number) => ['Store Manager', 'Warehouse Staff', 'Support Staff'].map((name, i) => ({ _id: `r${i}`, name, isPreset: true, presetVersion: version, permissions: ['orders.view'] }));

  it('adds permissions introduced later to an old Store Manager preset ONCE, keeping what the owner had, and refreshes its staff tokens', async () => {
    const { svc, roleModel, staffMemberModel } = setup(presets(0));
    await svc.list('o', 'seller', 'st');
    const mgr = (roleModel.updateOne as jest.Mock).mock.calls.find((c: any[]) => c[0]._id === 'r0')!;
    expect(mgr[1].$set.permissions).toEqual(expect.arrayContaining(['orders.view', 'products.create', 'collections.manage', 'categories.manage', 'draft_orders.manage', 'reviews.manage', 'activity_log.view']));
    expect(mgr[1].$set.presetVersion).toBe(1);
    const warehouse = (roleModel.updateOne as jest.Mock).mock.calls.find((c: any[]) => c[0]._id === 'r1')!;
    expect(warehouse[1].$set.permissions).toEqual(['orders.view']); // nothing new for Warehouse
    expect(staffMemberModel.updateMany).toHaveBeenCalled();
  });

  it('does nothing for presets that are already up to date', async () => {
    const { svc, roleModel } = setup(presets(1));
    await svc.list('o', 'seller', 'st');
    expect(roleModel.updateOne).not.toHaveBeenCalled();
  });
});
