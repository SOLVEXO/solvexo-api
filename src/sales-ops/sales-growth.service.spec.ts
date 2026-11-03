/* eslint-disable prettier/prettier */
import { SalesOpsService } from './sales-ops.service';
import { SalesCaptureService } from './sales-capture.service';
import { SalesGrowthService } from './sales-growth.service';
import { salesActor } from './sales-ops.util';
import { model } from './sales-ops.fakes.testspec';

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const B = 'b'.repeat(24),
  C = 'c'.repeat(24);

function setup(extra: { sellers?: any[]; stores?: any[]; subs?: any[] } = {}) {
  const repos: any = {
    adminModel: model([
      {
        _id: SUPER.adminId,
        name: 'Atiq',
        isSuperAdmin: true,
        status: 'active',
      },
      { _id: B, name: 'Bilal', roleId: 'r1', status: 'active' },
      { _id: C, name: 'Sana', roleId: 'r1', status: 'active' },
    ]),
    adminRoleModel: model([
      { _id: 'r1', isDelete: false, permissions: ['sales.access'] },
    ]),
    sellerModel: model(extra.sellers ?? []),
    storeModel: model(extra.stores ?? []),
    sellerPlatformSubscriptionModel: model(extra.subs ?? []),
    platformPlanModel: model([]),
  };
  const db = { repositories: repos } as any;
  const leads = model(),
    activities = model(),
    tasks = model(),
    templates = model(),
    contacts = model();
  const campaigns = model(),
    targets = model(),
    settings = model();
  const redis = {
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const email = { sendMail: jest.fn(async () => true) };
  const notifications = { notify: jest.fn(async () => undefined) };
  const fx = { getCurrentRate: jest.fn(async () => ({ ratePerUSD: 280 })) };
  const sales = new SalesOpsService(
    db,
    redis as any,
    email as any,
    leads as any,
    activities as any,
    tasks as any,
    templates as any,
  );
  const growth = new SalesGrowthService(
    db,
    fx as any,
    notifications as any,
    sales,
    leads as any,
    activities as any,
    campaigns as any,
    targets as any,
    settings as any,
  );
  const capture = new SalesCaptureService(
    db,
    redis as any,
    email as any,
    notifications as any,
    { stuck: async () => [] } as any,
    sales,
    leads as any,
    activities as any,
    contacts as any,
    growth,
  );
  return { sales, growth, capture, leads, campaigns, notifications };
}

describe('SalesGrowthService', () => {
  it('creates a campaign with a tagged link, logs spend and reports what it brought in', async () => {
    const seller = {
      _id: 'd'.repeat(24),
      acquisitionCampaign: 'Eid-Sale',
      isDelete: false,
    };
    const { growth, capture } = setup({
      sellers: [seller],
      stores: [{ _id: 'e'.repeat(24), sellerId: seller._id }],
      subs: [
        {
          storeId: 'e'.repeat(24),
          status: 'active',
          amountUSD: 10,
          billingInterval: 'monthly',
          startedAt: new Date('2026-10-01'),
          isDelete: false,
        },
      ],
    });
    const created = await growth.saveCampaign(SUPER, null, {
      name: 'Eid Sale',
      channel: 'facebook',
    });
    expect(created.data).toMatchObject({
      code: 'eid-sale',
      link: 'https://solvexo.store/book-demo?utm_source=facebook&utm_medium=paid_social&utm_campaign=eid-sale',
    });
    await expect(
      growth.saveCampaign(SUPER, null, { name: 'Eid sale' }),
    ).rejects.toThrow('already uses the code');

    await capture.demoRequest({
      name: 'Sara',
      phone: '03001112223',
      utmCampaign: 'eid-sale',
    });
    await growth.addSpend(SUPER, created.data.id, {
      date: '2026-11-01',
      amountPKR: 30000,
      note: 'Boost',
    });
    const r = await growth.addSpend(SUPER, created.data.id, {
      date: '2026-11-02',
      amountPKR: 20000,
    });
    expect(r.data).toMatchObject({
      spendPKR: 50000,
      leads: 1,
      signups: 1,
      paying: 1,
      payingNow: 1,
      mrrUSD: 10,
      mrrPKR: 2800,
      costPerPayingPKR: 50000,
    });
    expect(r.data.spend.map((s: any) => s.amountPKR)).toEqual([20000, 30000]);
    const after = await growth.removeSpend(
      created.data.id,
      r.data.spend[0]._id,
    );
    expect(after.data.spendPKR).toBe(30000);

    const list = await growth.listCampaigns();
    expect(list.data.totals).toMatchObject({
      spendPKR: 30000,
      leads: 1,
      paying: 1,
      costPerPayingPKR: 30000,
    });
  });

  it('gives leads that arrive on their own to the chosen reps in turn, and tells them', async () => {
    const { growth, capture, leads, notifications } = setup();
    await expect(
      growth.saveSettings({ autoAssign: true, assigneeIds: [] }),
    ).rejects.toThrow('at least one');
    await growth.saveSettings({
      autoAssign: true,
      assigneeIds: [B, C, 'f'.repeat(24)],
    });
    expect((await growth.getSettings()).data.assigneeIds).toEqual([B, C]);
    for (const n of ['1', '2', '3'])
      await capture.demoRequest({ name: `Lead ${n}`, phone: `0300111000${n}` });
    expect(leads.rows.map((l: any) => l.ownerAdminId)).toEqual([B, C, B]);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: C,
        title: 'New lead for you: Lead 2',
      }),
    );
    await growth.saveSettings({ autoAssign: false, assigneeIds: [B] });
    await capture.demoRequest({ name: 'Lead 4', phone: '03001110004' });
    expect(leads.rows[3].ownerAdminId).toBeNull();
  });

  it('builds the month leaderboard with targets', async () => {
    const { growth, sales } = setup();
    const rep = salesActor({
      userId: B,
      teamAdmin: true,
      permissions: ['sales.access'],
    });
    const a = await sales.create(rep, {
      name: 'Hamza',
      phone: '03211110000',
      dealValuePKR: 60000,
    });
    await sales.addActivity(rep, a.data.lead._id, 'call', 'Talked', 'Talked');
    await sales.changeStage(rep, a.data.lead._id, 'demo');
    await sales.changeStage(rep, a.data.lead._id, 'won');
    const month = new Date(Date.now() + 5 * 3_600_000)
      .toISOString()
      .slice(0, 7);
    const t = await growth.saveTargets(SUPER, month, [
      { adminId: B, wonDeals: 2, wonValuePKR: 120000 },
      { adminId: 'f'.repeat(24), wonDeals: 9 },
    ]);
    const bilal = t.data.reps.find((r: any) => r.name === 'Bilal');
    expect(bilal).toMatchObject({
      newLeads: 1,
      activities: 1,
      demos: 1,
      won: 1,
      wonValuePKR: 60000,
      progress: { wonDeals: 50, wonValuePKR: 50, activities: null },
    });
    expect(t.data.reps[0].name).toBe('Bilal');
    await expect(growth.saveTargets(SUPER, '2026-13', [])).rejects.toThrow(
      'Choose a month',
    );
  });
});
