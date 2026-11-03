/* eslint-disable prettier/prettier */
import { AdminDigestService } from './admin-digest.service';

const q = (rows: any) => { const p: any = Promise.resolve(rows); p.select = () => p; p.lean = () => p; return p; };

function build(opts: { alerts?: any[]; healthFails?: boolean } = {}) {
  const store = new Map<string, string>();
  const redis: any = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) => { await fn(); return 'ok'; }),
  };
  const admins = [
    { _id: 'owner', isSuperAdmin: true, weeklyDigest: true },
    { _id: 'analyst', roleId: 'r-analytics', weeklyDigest: false },
    { _id: 'support', roleId: 'r-support', weeklyDigest: true },
    { _id: 'expired', isSuperAdmin: true, accessExpiresAt: new Date(Date.now() - 1000) },
  ];
  const db: any = { repositories: {
    adminModel: { find: jest.fn(() => q(admins)) },
    adminRoleModel: { find: jest.fn(() => q([{ _id: 'r-analytics', permissions: ['analytics.view'] }, { _id: 'r-support', permissions: ['clients.view'] }])) },
    sellerModel: { countDocuments: jest.fn(async () => 4) },
    storeModel: { countDocuments: jest.fn(async () => 3) },
  } };
  const notifications: any = { notify: jest.fn(async () => undefined) };
  const alerts: any = { getAlerts: jest.fn(async () => ({ data: { alerts: opts.alerts ?? [] } })) };
  const saas: any = { weekOverWeek: jest.fn(async () => ({ mrr: 100, payingStores: 2, arpu: 50, mrrWeekAgo: null, newMrr: null, churnedMrr: null, newPayingStores: null, churnedStores: null })) };
  const funnel: any = { getFunnel: jest.fn(async () => ({ data: { stuck: [] } })) };
  const health: any = { list: jest.fn(async () => { if (opts.healthFails) throw new Error('db down'); return { data: { summary: { atRisk: 0, attention: 1, mrrAtRisk: 0 }, items: [] } }; }) };
  return { svc: new AdminDigestService(db, redis, notifications, alerts, saas, funnel, health), notifications, redis };
}

describe('AdminDigestService', () => {
  it('recipients: Super Admins and analytics roles, never expired access or roles without analytics', async () => {
    const { svc } = build();
    expect((await svc.recipients()).map((a) => a._id)).toEqual(['owner', 'analyst']);
  });

  it('sends a critical / warning alert once, not again while it stays active, and ignores info alerts', async () => {
    const { svc, notifications } = build({ alerts: [
      { id: 'redis-down', severity: 'critical', category: 'Infrastructure', message: 'Redis is down' },
      { id: 'sellers-dormant', severity: 'info', category: 'Sellers', message: '3 dormant' },
    ] });
    expect(await svc.notifyNewAlerts()).toBe(1);
    expect(notifications.notify).toHaveBeenCalledTimes(2); // owner + analyst
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({ type: 'admin_platform_alert', title: 'Critical: Infrastructure', body: 'Redis is down' });
    expect(await svc.notifyNewAlerts()).toBe(0);
    expect(notifications.notify).toHaveBeenCalledTimes(2);
  });

  it('weekly digest goes only to admins who kept it on; a test send goes to the caller even if they turned it off', async () => {
    const { svc, notifications } = build();
    expect(await svc.sendDigest()).toBe(1);
    expect(notifications.notify.mock.calls[0][0]).toMatchObject({ recipientId: 'owner', type: 'admin_weekly_digest', email: { subject: expect.stringContaining('Solvexo weekly') } });
    expect(await svc.sendDigest('analyst')).toBe(1);
    expect(notifications.notify.mock.calls[1][0].recipientId).toBe('analyst');
  });

  it('one failing source leaves that section empty instead of failing the digest', async () => {
    const { svc } = build({ healthFails: true });
    const data = await svc.collect();
    expect(data.health).toBeNull();
    expect(data.growth).toEqual({ newSellers: 4, newStores: 3 });
    expect(data.revenue?.mrr).toBe(100);
  });
});
