import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { SellerMembershipsController } from '../memberships/memberships.controller';
import { SellerRenewalInvoicesController } from '../memberships/renewal-invoices.controller';
import { SellerLicensesController } from '../licenses/licenses.controller';
import { SellerCoursesController } from '../courses/courses.controller';
import { DigitalSellerController } from './digital-access.controller';
import { AdminDigitalController } from './admin-digital.controller';
import { REQUIRE_PERMISSION_KEY } from '../auth/decorators/require-permission.decorator';

const guard = new PermissionsGuard(new Reflector(), { repositories: {} } as any);
const ctx = (cls: any, handler: string, user: any, params: any = { storeId: 's1' }, method = 'GET'): any => ({
  getHandler: () => cls.prototype[handler],
  getClass: () => cls,
  switchToHttp: () => ({ getRequest: () => ({ user, params, query: {}, body: {}, method, path: '/x', route: { path: '/x' } }) }),
});
const staff = (permissions: string[], storeId = 's1') => ({ role: 'staff', userId: 'st1', storeId, permissions });

const ROUTES: [any, string, string][] = [
  [SellerMembershipsController, 'plans', 'members.manage'],
  [SellerMembershipsController, 'create', 'members.manage'],
  [SellerMembershipsController, 'subs', 'members.manage'],
  [SellerMembershipsController, 'paid', 'members.manage'],
  [SellerRenewalInvoicesController, 'list', 'members.manage'],
  [SellerRenewalInvoicesController, 'approve', 'members.manage'],
  [SellerRenewalInvoicesController, 'reject', 'members.manage'],
  [SellerRenewalInvoicesController, 'voidIt', 'members.manage'],
  [SellerRenewalInvoicesController, 'remind', 'members.manage'],
  [SellerRenewalInvoicesController, 'proofUrl', 'members.manage'],
  [SellerLicensesController, 'list', 'licenses.manage'],
  [SellerLicensesController, 'token', 'licenses.manage'],
  [SellerCoursesController, 'list', 'courses.manage'],
  [SellerCoursesController, 'create', 'courses.manage'],
  [DigitalSellerController, 'overview', 'digital.view'],
  [DigitalSellerController, 'reports', 'digital.view'],
  [DigitalSellerController, 'settings', 'digital.view'],
  [DigitalSellerController, 'updateSettings', 'digital.manage'],
  [DigitalSellerController, 'log', 'digital.view'],
  [DigitalSellerController, 'revoke', 'digital.manage'],
  [DigitalSellerController, 'resend', 'digital.manage'],
];

describe('seller digital routes: permissions', () => {
  it('every seller route declares the permission it needs', () => {
    for (const [cls, handler, perm] of ROUTES) {
      const required = new Reflector().getAllAndOverride<string[]>(REQUIRE_PERMISSION_KEY, [cls.prototype[handler], cls]);
      expect(Array.isArray(required) && required.includes(perm)).toBe(true);
    }
  });

  it('no identity is refused', async () => {
    for (const [cls, handler] of ROUTES) await expect(guard.canActivate(ctx(cls, handler, undefined))).rejects.toThrow('Access Denied');
  });

  it('staff without the permission is refused (forbidden)', async () => {
    for (const [cls, handler] of ROUTES) await expect(guard.canActivate(ctx(cls, handler, staff(['orders.view'])))).rejects.toThrow('permission');
  });

  it('staff with the permission, in its own store, is let through', async () => {
    for (const [cls, handler, perm] of ROUTES) expect(await guard.canActivate(ctx(cls, handler, staff([perm])))).toBe(true);
  });

  it('staff of ANOTHER store is refused even with the permission', async () => {
    for (const [cls, handler, perm] of ROUTES) await expect(guard.canActivate(ctx(cls, handler, staff([perm], 's2')))).rejects.toThrow();
  });

  it('the store owner (seller) is always let through', async () => {
    for (const [cls, handler] of ROUTES) expect(await guard.canActivate(ctx(cls, handler, { role: 'seller', userId: 'sel1' }))).toBe(true);
  });
});

describe('super admin digital routes', () => {
  it('a team admin needs config.manage; a read-only role cannot change anything; the owner admin is open', async () => {
    const team = (permissions: string[], readOnly = false) => ({ role: 'admin', teamAdmin: true, permissions, readOnly, userId: 'a1' });
    await expect(guard.canActivate(ctx(AdminDigitalController, 'disableStore', team(['analytics.view']), {}, 'POST'))).rejects.toThrow('permission');
    expect(await guard.canActivate(ctx(AdminDigitalController, 'disableStore', team(['config.manage']), {}, 'POST'))).toBe(true);
    await expect(guard.canActivate(ctx(AdminDigitalController, 'disableStore', team(['config.manage'], true), {}, 'POST'))).rejects.toThrow('read-only');
    expect(await guard.canActivate(ctx(AdminDigitalController, 'overview', { role: 'admin', userId: 'owner' }))).toBe(true);
  });
});
