import { AdminTeamService } from './admin-team.service';
import { ADMIN_PERMISSIONS } from './admin-permissions';
import { FakeModel } from '../digital-access/testing/fake-db.kit-spec';

/** A permission whose feature was removed (ai.manage, the admin AI Studio) must not break a role that still carries it. */
function setup() {
  const roles = new FakeModel({ isDelete: false });
  const admins = new FakeModel();
  const calls: any[] = [];
  const origUpdateMany = roles.updateMany.bind(roles);
  (roles as any).updateMany = async (f: any, u: any) => { calls.push({ f, u }); return origUpdateMany({ _id: 'none' }, {}); };
  const db: any = { repositories: { adminRoleModel: roles, adminModel: admins } };
  const svc = new AdminTeamService(db, {} as any, {} as any, { log: async () => undefined } as any, {} as any, {} as any);
  const superAdmin = { userId: 'a1' }; // not a team admin = Super Admin
  return { svc, roles, calls, superAdmin };
}

describe('retired admin permission: ai.manage', () => {
  it('is no longer a permission anyone can be given', () => {
    expect((ADMIN_PERMISSIONS as readonly string[]).includes('ai.manage')).toBe(false);
  });

  it('a role that still carries it can be checked and saved (the key is ignored, not an error)', async () => {
    const { svc, superAdmin } = setup();
    await (svc as any).assertRoleGrantable(superAdmin, ['clients.view', 'ai.manage']);
  });

  it('a genuinely unknown permission is still refused', async () => {
    const { svc, superAdmin } = setup();
    let failed = false;
    try { await (svc as any).assertRoleGrantable(superAdmin, ['clients.view', 'made.up']); } catch (e: any) { failed = String(e.message).includes('Unknown permission'); }
    expect(failed).toBe(true);
  });

  it('creating a role drops the retired key from what is stored', async () => {
    const { svc, roles, superAdmin } = setup();
    await svc.createRole(superAdmin as any, { name: 'Content', permissions: ['seo.manage', 'ai.manage'] });
    expect(roles.rows[0].permissions).toEqual(['seo.manage']);
  });

  it('updating a role drops the retired key too', async () => {
    const { svc, roles, superAdmin } = setup();
    roles.rows.push({ _id: 'r1', name: 'Old', permissions: ['seo.manage', 'ai.manage'], isDelete: false, readOnly: false });
    await svc.updateRole(superAdmin as any, 'r1', { permissions: ['seo.manage', 'ai.manage', 'content.manage'] });
    expect(roles.rows[0].permissions).toEqual(['seo.manage', 'content.manage']);
  });

  it('at boot the retired key is pulled out of stored roles', async () => {
    const { svc, calls } = setup();
    await svc.onModuleInit();
    const pull = calls.find((c) => c.u?.$pull);
    expect(pull.f).toEqual({ permissions: { $in: ['ai.manage'] } });
    expect(pull.u.$pull).toEqual({ permissions: { $in: ['ai.manage'] } });
  });
});
