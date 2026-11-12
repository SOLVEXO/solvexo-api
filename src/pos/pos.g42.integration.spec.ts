/* eslint-disable prettier/prettier */
import 'reflect-metadata';
import * as jwt from 'jsonwebtoken';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosPermissionsStoreService } from './pos-permissions-store.service';
import { PosInventoryService } from './pos-inventory.service';
import { MongoHarness, seedStore, startMongoHarness } from './testing/mongo-harness';
import { moneyContractViolations } from './testing/money-contract';
import { effectiveRule, effectiveTable, evaluate, normalizeOverrides, overrideErrors, PINNED_ACTIONS, POS_ACTIONS, POS_PERMISSIONS, POS_ROLES, resolveLimits } from './pos-permissions.config';

/** G4.2: the permission matrix, editable per store by the owner — invariants, effective table, the authorizer obeying it, versioning, reset, audit. */
jest.setTimeout(300_000);

describe('overrides (pure)', () => {
  const L = resolveLimits(null, 2);
  it('no overrides = the documented table, action by action, role by role', () => {
    const t = effectiveTable({});
    for (const a of POS_ACTIONS) for (const role of POS_ROLES) expect([a, role, evaluate(a, role, { amountMinor: 10 ** 9, qty: 10 ** 6, valueMinor: 10 ** 9, points: 10 ** 6 }, L, t)]).toEqual([a, role, evaluate(a, role, { amountMinor: 10 ** 9, qty: 10 ** 6, valueMinor: 10 ** 9, points: 10 ** 6 }, L)]);
  });
  it('invariants: the owner can never be removed; pinned actions cannot change; unknown actions / roles / approvers are refused', () => {
    expect(overrideErrors({ 'inventory.writeoff': { roles: ['manager'] } })).toEqual(['inventory.writeoff: the owner can always do everything']);
    expect(overrideErrors({ 'settings.permissions.edit': { roles: ['manager', 'owner'] } })[0]).toMatch(/pinned/);
    expect(overrideErrors({ 'nope.action': { roles: ['owner'] } })[0]).toMatch(/unknown action/);
    expect(overrideErrors({ 'inventory.writeoff': { roles: ['owner', 'god'] } })[0]).toMatch(/roles must be/);
    expect(overrideErrors({ 'cash.out': { approval: [{ approver: 'cashier' }] } })[0]).toMatch(/approver must be/);
    expect(overrideErrors({ 'cash.out': { approval: [{}, {}] } })[0]).toMatch(/approval must follow/);
    // even a bad stored override cannot drop the owner or touch a pinned action
    expect(effectiveRule('inventory.writeoff', { roles: [] as any }).roles).toEqual(['owner']);
    expect(effectiveRule('settings.permissions.edit', { roles: ['cashier', 'manager', 'owner'] })).toBe((POS_PERMISSIONS as any)['settings.permissions.edit']);
  });
  it('granting, removing and re-routing approval change decisions exactly as configured', () => {
    const t = effectiveTable({ 'inventory.writeoff': { roles: ['cashier', 'manager', 'owner'] }, 'customers.create': { roles: ['manager', 'owner'] }, 'cash.out': { approval: [{ approver: 'owner' }] }, 'expenses.record': { approval: [{ enabled: false }] } });
    expect(evaluate('inventory.writeoff', 'cashier', {}, L, t).decision).toBe('allow');
    expect(evaluate('customers.create', 'cashier', {}, L, t)).toEqual({ decision: 'deny', reason: 'role_not_allowed' });
    expect(evaluate('cash.out', 'manager', { amountMinor: L.cashOutMinor + 1 }, L, t)).toMatchObject({ decision: 'needs_approval', approver: 'owner' });
    expect(evaluate('expenses.record', 'cashier', { amountMinor: 10 ** 9 }, L, t).decision).toBe('allow');
  });
  it('normalizing drops anything equal to the default (so "reset" is simply {})', () => {
    expect(normalizeOverrides({ 'inventory.writeoff': { roles: ['manager', 'owner'] }, 'cash.out': { approval: [{ enabled: true, approver: 'manager' }] } })).toEqual({});
    expect(normalizeOverrides({ 'inventory.writeoff': { roles: ['cashier', 'owner'] } })).toEqual({ 'inventory.writeoff': { roles: ['cashier', 'owner'] } });
    expect(PINNED_ACTIONS).toEqual(['settings.permissions.edit', 'settings.permissions.view']);
  });
  it('random override sets never break the invariants (500 rounds)', () => {
    let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 500; i++) {
      const ov: any = {};
      for (const a of POS_ACTIONS) if (rnd() < 0.3) ov[a] = { roles: POS_ROLES.filter(() => rnd() < 0.6), approval: ((POS_PERMISSIONS as any)[a].approval ?? []).map(() => ({ enabled: rnd() < 0.5, approver: rnd() < 0.5 ? 'manager' : 'owner' })) };
      const t = effectiveTable(ov);
      for (const a of POS_ACTIONS) {
        expect(evaluate(a, 'owner', { amountMinor: 10 ** 9 }, L, t).decision).toBe('allow'); // the owner always may
        if (PINNED_ACTIONS.includes(a)) expect(t[a]).toBe((POS_PERMISSIONS as any)[a]);
      }
    }
  });
});

let h: MongoHarness; let pos: PosService; let perms: PosPermissionsStoreService; let auth: PosAuthorizer; let r: any;
describe('per-store matrix through the service and the authorizer', () => {
  beforeAll(async () => {
    process.env.JWT_SECRET = 'test-secret';
    h = await startMongoHarness(); r = h.repos;
    const dbs: any = { repositories: r };
    pos = new PosService(dbs, { log: jest.fn() } as any, {} as any, { recordSale: jest.fn(), recordRefund: jest.fn() } as any);
    auth = new PosAuthorizer(dbs, pos);
    perms = new PosPermissionsStoreService(dbs, pos, auth);
  });
  afterAll(async () => { await h?.stop(); });
  type Seed = Awaited<ReturnType<typeof seedStore>>;
  const tok = (s: Seed, who: 'manager' | 'cashier') => jwt.sign({ employeeId: who === 'manager' ? s.managerId : s.cashierId, storeId: s.storeId, role: who, type: 'pos_employee' }, 'test-secret', { expiresIn: '1h' });
  const device = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller', posDevice: { deviceId: 'd1', storeId: s.storeId } } });
  const owner = (s: Seed) => ({ user: { userId: s.sellerId, role: 'seller' } });
  const code = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.response?.code ?? e?.message ?? 'error'; } };

  it('a manager reads the matrix but cannot change it; a cashier cannot read it; the owner changes it (preview diff → save → audit with before/after; version bumps)', async () => {
    const s = await seedStore(h);
    const M = { employee: tok(s, 'manager') }; const C = { employee: tok(s, 'cashier') };
    const got = (await perms.get(device(s), s.storeId, M)).data;
    expect(moneyContractViolations(got)).toEqual([]); // the money contract (no amount without its currency) holds here too
    expect([got.version, got.canEdit, got.actions.length]).toEqual([0, false, POS_ACTIONS.length]);
    expect(await code(perms.get(device(s), s.storeId, C))).toBe('POS_ACTION_FORBIDDEN');
    expect(await code(perms.update(device(s), s.storeId, { changes: { 'inventory.writeoff': { roles: ['cashier', 'manager', 'owner'] } } }, M))).toBe('POS_ACTION_FORBIDDEN');
    const prev: any = (await perms.update(owner(s), s.storeId, { preview: true, changes: { 'inventory.writeoff': { roles: ['cashier', 'manager', 'owner'] } } }, {})).data;
    expect(prev.diff).toEqual([{ action: 'inventory.writeoff', field: 'roles', before: ['manager', 'owner'], after: ['cashier', 'manager', 'owner'] }]);
    expect((await perms.get(device(s), s.storeId, M)).data.version).toBe(0); // a preview saved nothing
    const saved: any = (await perms.update(owner(s), s.storeId, { expectedVersion: 0, changes: { 'inventory.writeoff': { roles: ['cashier', 'manager', 'owner'] } } }, {})).data;
    expect(saved.version).toBe(1);
    expect(saved.actions.find((x: any) => x.action === 'inventory.writeoff')).toMatchObject({ changed: true, roles: ['cashier', 'manager', 'owner'], defaultRoles: ['manager', 'owner'] });
    const audit: any = await r.posAuditLogModel.findOne({ storeId: s.storeId, action: 'permissions_changed' }).lean();
    expect(audit.metadata.diff[0]).toMatchObject({ action: 'inventory.writeoff', field: 'roles' });
    // a stale screen (old version) is refused
    expect(await code(perms.update(owner(s), s.storeId, { expectedVersion: 0, changes: { 'customers.create': { roles: ['manager', 'owner'] } } }, {}))).toBe('VERSION_CONFLICT');
    // invalid changes are refused with every reason
    expect(await code(perms.update(owner(s), s.storeId, { changes: { 'inventory.writeoff': { roles: ['cashier'] } } }, {}))).toBe('INVALID_PERMISSIONS');
    expect(await code(perms.update(owner(s), s.storeId, { changes: { 'settings.permissions.edit': { roles: ['manager', 'owner'] } } }, {}))).toBe('INVALID_PERMISSIONS');
  });

  it('the authorizer obeys the store\'s matrix at once — and only for that store; reset brings the defaults back (audited)', async () => {
    const s = await seedStore(h); const other = await seedStore(h);
    const C = { employee: tok(s, 'cashier') };
    const ask = (st: Seed, action: any, t: any, ctx: any = {}) => code(auth.authorize(device(st), { storeId: st.storeId, action, ctx, employeeToken: t.employee }));
    expect(await ask(s, 'inventory.writeoff', C)).toBe('POS_ACTION_FORBIDDEN');
    await perms.update(owner(s), s.storeId, { changes: { 'inventory.writeoff': { roles: ['cashier', 'manager', 'owner'] }, 'customers.create': { roles: ['manager', 'owner'] }, 'cash.out': { approval: [{ approver: 'owner' }] } } }, {});
    expect(await ask(s, 'inventory.writeoff', C)).toBeNull();                 // granted
    expect(await ask(s, 'customers.create', C)).toBe('POS_ACTION_FORBIDDEN'); // removed
    expect(await ask(s, 'cash.out', { employee: tok(s, 'manager') }, { amountMinor: 10 ** 7 })).toBe('POS_OWNER_REQUIRED'); // re-routed to the owner
    expect(await ask(other, 'inventory.writeoff', { employee: tok(other, 'cashier') })).toBe('POS_ACTION_FORBIDDEN'); // another store keeps the defaults
    const back: any = (await perms.reset(owner(s), s.storeId, {}, {})).data;
    expect(back.actions.every((x: any) => !x.changed)).toBe(true);
    expect(await ask(s, 'inventory.writeoff', C)).toBe('POS_ACTION_FORBIDDEN');
    expect(await ask(s, 'customers.create', C)).toBeNull();
    expect(await r.posAuditLogModel.countDocuments({ storeId: s.storeId, action: 'permissions_reset' })).toBe(1);
    // the approval-limits screen still works off the same policy
    const inv = new PosInventoryService({ repositories: r } as any, pos, auth, {} as any, {} as any);
    expect((await inv.limits(device(s) as any, s.storeId, { employee: tok(s, 'manager') })).data.limits.length).toBeGreaterThan(5);
  });
});
