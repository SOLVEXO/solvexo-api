/* eslint-disable prettier/prettier */
/** "Require two-factor for staff": grace period, then a real block until the person turns it on. Owner and admin are never blocked. */
import { PermissionsGuard, clearStaffTwoFactorCache } from './permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';

const DAY = 86_400_000;
function setup(store: any, enabledStaff: string[] = []) {
  const reflector: any = { getAllAndOverride: jest.fn((key: any) => (key === REQUIRE_PERMISSION_KEY ? ['orders.view'] : false)) };
  const db: any = { repositories: { storeModel: { findById: () => ({ select: () => ({ lean: async () => store }) }) } } };
  const tf: any = { isEnabled: jest.fn(async (_k: string, id: string) => enabledStaff.includes(id)) };
  const guard = new PermissionsGuard(reflector, db, tf);
  const run = (user: any) => guard.canActivate({ getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ user, params: {}, query: {}, body: {}, route: { path: '/api/orders/x' }, path: '/api/orders/x' }) }) } as any);
  return { run, tf };
}
const staff = (id = 'st1') => ({ role: 'staff', userId: id, sellerId: 'own', storeId: 'S1', permissions: ['orders.view'] });

describe('staff two-factor policy in PermissionsGuard', () => {
  beforeEach(() => clearStaffTwoFactorCache());
  it('policy off: nobody is blocked and two-factor is not even looked up', async () => {
    const { run, tf } = setup({ requireStaffTwoFactor: false });
    await expect(run(staff())).resolves.toBe(true); expect(tf.isEnabled).not.toHaveBeenCalled();
  });
  it('inside the grace period staff keep working', async () => {
    const { run } = setup({ requireStaffTwoFactor: true, requireStaffTwoFactorSince: new Date(Date.now() - 2 * DAY), staffTwoFactorGraceDays: 7 });
    await expect(run(staff())).resolves.toBe(true);
  });
  it('after the grace period a staff member WITHOUT two-factor is refused with TWO_FACTOR_REQUIRED, one WITH it passes', async () => {
    const store = { requireStaffTwoFactor: true, requireStaffTwoFactorSince: new Date(Date.now() - 8 * DAY), staffTwoFactorGraceDays: 7 };
    const { run } = setup(store, ['st2']);
    await expect(run(staff('st1'))).rejects.toMatchObject({ response: { code: 'TWO_FACTOR_REQUIRED' } });
    await expect(run(staff('st2'))).resolves.toBe(true);
  });
  it('grace 0 blocks at once; a policy with no start date counts as already started', async () => {
    const { run } = setup({ requireStaffTwoFactor: true, requireStaffTwoFactorSince: new Date(), staffTwoFactorGraceDays: 0 });
    await expect(run(staff())).rejects.toMatchObject({ response: { code: 'TWO_FACTOR_REQUIRED' } });
    const legacy = setup({ requireStaffTwoFactor: true, requireStaffTwoFactorSince: null, staffTwoFactorGraceDays: 7 });
    await expect(legacy.run(staff())).rejects.toMatchObject({ response: { code: 'TWO_FACTOR_REQUIRED' } });
  });
  it('the owner (seller) is never blocked by the staff policy', async () => {
    const { run } = setup({ requireStaffTwoFactor: true, requireStaffTwoFactorSince: new Date(0), staffTwoFactorGraceDays: 0 });
    await expect(run({ role: 'seller', userId: 'own' })).resolves.toBe(true);
  });
  it('REGRESSION (smoke): a policy change applies at once (the per-minute verdict cache is cleared), not up to a minute later', async () => {
    clearStaffTwoFactorCache();
    const store: any = { requireStaffTwoFactor: false };
    const { run } = setup(store);
    await expect(run(staff('stX'))).resolves.toBe(true); // verdict cached: allowed
    Object.assign(store, { requireStaffTwoFactor: true, requireStaffTwoFactorSince: new Date(0), staffTwoFactorGraceDays: 0 });
    await expect(run(staff('stX'))).resolves.toBe(true); // still the cached verdict
    clearStaffTwoFactorCache();
    await expect(run(staff('stX'))).rejects.toMatchObject({ response: { code: 'TWO_FACTOR_REQUIRED' } });
  });
});
