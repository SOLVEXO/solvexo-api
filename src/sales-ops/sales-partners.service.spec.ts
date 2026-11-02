/* eslint-disable prettier/prettier */
import { SalesPartnersService } from './sales-partners.service';
import { salesActor } from './sales-ops.util';
import { model } from './sales-ops.fakes.testspec';

const SUPER = salesActor({ userId: 'a'.repeat(24) });
const REP_ID = 'b'.repeat(24),
  AGENT_LOGIN = 'c'.repeat(24);
const S1 = '1'.repeat(24),
  S2 = '2'.repeat(24),
  ST1 = '3'.repeat(24),
  ST2 = '4'.repeat(24);
const DAY = 86_400_000;

function setup() {
  const now = Date.now();
  const repos: any = {
    adminModel: model([
      { _id: SUPER.adminId, name: 'Atiq' },
      { _id: REP_ID, name: 'Bilal' },
      { _id: AGENT_LOGIN, name: 'Kamran' },
    ]),
    sellerModel: model([
      {
        _id: S1,
        name: 'Sara',
        email: 'sara@shop.example',
        createdAt: new Date(now - 60 * DAY),
        acquisitionPartnerCode: 'KAMRAN1',
        isDelete: false,
      },
      {
        _id: S2,
        name: 'Hamza',
        email: 'hamza@shop.example',
        createdAt: new Date(now - 40 * DAY),
        acquisitionPartnerCode: null,
        isDelete: false,
      },
    ]),
    storeModel: model([
      {
        _id: ST1,
        sellerId: S1,
        name: 'Sara Boutique',
        createdAt: new Date(now - 59 * DAY),
      },
      {
        _id: ST2,
        sellerId: S2,
        name: 'Hamza Mart',
        createdAt: new Date(now - 39 * DAY),
      },
    ]),
    sellerPlatformSubscriptionModel: model([
      {
        storeId: ST1,
        status: 'active',
        amountUSD: 11.8,
        billingInterval: 'monthly',
        isDelete: false,
      },
    ]),
    platformPlanInvoiceModel: model([
      {
        _id: '5'.repeat(24),
        storeId: ST1,
        sellerId: S1,
        invoiceNumber: 'PP-1',
        amountUSD: 11.8,
        subtotalUSD: 10,
        taxAmountUSD: 1.8,
        refundedAmountUSD: 0,
        status: 'paid',
        paidAt: new Date(now - 30 * DAY),
        isDelete: false,
      },
      {
        _id: '6'.repeat(24),
        storeId: ST1,
        sellerId: S1,
        invoiceNumber: 'PP-2',
        amountUSD: 11.8,
        subtotalUSD: 10,
        taxAmountUSD: 1.8,
        refundedAmountUSD: 0,
        status: 'paid',
        paidAt: new Date(now - 2 * DAY),
        isDelete: false,
      },
      {
        _id: '7'.repeat(24),
        storeId: ST2,
        sellerId: S2,
        invoiceNumber: 'PP-3',
        amountUSD: 20,
        subtotalUSD: null,
        taxAmountUSD: 0,
        refundedAmountUSD: 0,
        status: 'paid',
        paidAt: new Date(now - 20 * DAY),
        isDelete: false,
      },
    ]),
  };
  const leads = model([
    {
      _id: '8'.repeat(24),
      name: 'Hamza',
      sellerId: S2,
      ownerAdminId: REP_ID,
      partnerId: null,
      isDelete: false,
    },
  ]);
  const partners = model(),
    plans = model(),
    referrals = model(),
    ledger = model(),
    payouts = model();
  const redis = {
    withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) =>
      fn(),
    ),
  };
  const fx = { getCurrentRate: jest.fn(async () => ({ ratePerUSD: 280 })) };
  const svc = new SalesPartnersService(
    { repositories: repos } as any,
    redis as any,
    fx as any,
    leads as any,
    partners as any,
    plans as any,
    referrals as any,
    ledger as any,
    payouts as any,
  );
  return { svc, partners, plans, referrals, ledger, payouts, fx };
}

describe('SalesPartnersService', () => {
  it('needs a plan to pay something', async () => {
    const { svc } = setup();
    await expect(svc.savePlan(null, { name: 'Nothing' })).rejects.toThrow(
      'one-time amount, a percentage, or both',
    );
    const r = await svc.savePlan(null, {
      name: 'Reseller',
      bountyPKR: 5000,
      percent: 20,
      percentMonths: 12,
      tiers: [{ minPaying: 10, percent: 25 }],
    });
    expect(r.data[0]).toMatchObject({
      name: 'Reseller',
      bountyPKR: 5000,
      percent: 20,
      holdDays: 14,
      tiers: [{ minPaying: 10, percent: 25 }],
    });
  });

  it('credits merchants to partners, writes commissions from real payments once, holds them, and pays them out', async () => {
    const { svc, plans, ledger, referrals } = setup();
    await svc.savePlan(null, {
      name: 'Reseller',
      bountyPKR: 5000,
      percent: 20,
      percentMonths: 12,
      holdDays: 14,
    });
    await svc.savePlan(null, { name: 'Rep', bountyPKR: 2000, percent: null });
    const [resellerPlan, repPlan] = plans.rows.map((p: any) => String(p._id));
    const agent = await svc.savePartner(SUPER, null, {
      name: 'Kamran Agencies',
      kind: 'reseller',
      code: 'kamran1',
      planId: resellerPlan,
      adminId: AGENT_LOGIN,
    });
    expect(agent.data.partner.code).toBe('KAMRAN1');
    expect(agent.data.link).toBe('https://solvexo.store/?partner=KAMRAN1');
    await svc.savePartner(SUPER, null, {
      name: 'Bilal',
      kind: 'rep',
      planId: repPlan,
      adminId: REP_ID,
    });
    await expect(
      svc.savePartner(SUPER, null, { name: 'Dup', code: 'KAMRAN1' }),
    ).rejects.toThrow('already belongs to Kamran Agencies');

    const r1 = await svc.run();
    expect(r1).toMatchObject({ attributed: 2 });
    expect(referrals.rows.map((x: any) => x.source).sort()).toEqual([
      'code',
      'lead_owner',
    ]);
    // Sara (via Kamran's link): 5,000 bounty + 20% of $10 × 280 on each of two invoices. Hamza (Bilal's lead): 2,000 bounty.
    const kamranId = agent.data.partner._id;
    const kamran = ledger.rows.filter((x: any) => x.partnerId === kamranId);
    expect(kamran.map((x: any) => [x.type, x.amountPKR, x.status])).toEqual([
      ['bounty', 5000, 'payable'],
      ['percent', 560, 'payable'],
      ['percent', 560, 'pending'],
    ]);
    expect((await svc.run()).created).toBe(0);

    const list = await svc.listPartners();
    expect(list.data.find((p: any) => p.code === 'KAMRAN1')).toMatchObject({
      referred: 1,
      payingNow: 1,
      payablePKR: 5560,
      pendingPKR: 560,
    });

    const paid = await svc.recordPayout(SUPER, kamranId, {
      method: 'jazzcash',
      reference: 'TX-991',
    });
    expect(paid.data.balances).toMatchObject({
      payablePKR: 0,
      pendingPKR: 560,
      paidPKR: 5560,
    });
    expect(paid.data.payouts[0]).toMatchObject({
      amountPKR: 5560,
      method: 'jazzcash',
      reference: 'TX-991',
    });
    await expect(svc.recordPayout(SUPER, kamranId, {})).rejects.toThrow(
      'Nothing is payable',
    );
  });

  it('shows a partner only their own earnings, without merchants’ contact details or manager notes', async () => {
    const { svc, plans } = setup();
    await svc.savePlan(null, { name: 'Reseller', bountyPKR: 5000 });
    await svc.savePartner(SUPER, null, {
      name: 'Kamran',
      code: 'KAMRAN1',
      planId: String(plans.rows[0]._id),
      adminId: AGENT_LOGIN,
      notes: 'Slow to pay back',
    });
    await svc.run();
    const me = await svc.me(
      salesActor({
        userId: AGENT_LOGIN,
        teamAdmin: true,
        permissions: ['partner.portal'],
      }),
    );
    expect(me.data!.partner).not.toHaveProperty('notes');
    expect(me.data!.referrals).toEqual([
      expect.objectContaining({
        merchant: 'Sara Boutique',
        payingNow: true,
        earnedPKR: 5000,
      }),
    ]);
    expect(JSON.stringify(me.data)).not.toContain('sara@shop.example');
    expect(
      (
        await svc.me(
          salesActor({
            userId: REP_ID,
            teamAdmin: true,
            permissions: ['sales.access'],
          }),
        )
      ).data,
    ).toBeNull();
  });

  it('lets a manager credit a merchant by hand and add a bonus line', async () => {
    const { svc, plans } = setup();
    await svc.savePlan(null, { name: 'Flat', bountyPKR: 3000 });
    const p = await svc.savePartner(SUPER, null, {
      name: 'Event partner',
      planId: String(plans.rows[0]._id),
    });
    const r = await svc.setReferral(SUPER, p.data.partner._id, {
      sellerEmail: 'HAMZA@shop.example',
    });
    expect(r.data.referrals).toEqual([
      expect.objectContaining({ merchant: 'Hamza Mart', source: 'manual' }),
    ]);
    expect(r.data.balances.payablePKR).toBe(3000);
    const b = await svc.addAdjustment(SUPER, p.data.partner._id, {
      amountPKR: 1500,
      description: 'Expo bonus',
    });
    expect(b.data.balances.payablePKR).toBe(4500);
    await expect(
      svc.setReferral(SUPER, p.data.partner._id, {
        sellerEmail: 'nobody@x.com',
      }),
    ).rejects.toThrow('No merchant account');
  });

  it('writes nothing until there is a PKR rate', async () => {
    const { svc, plans, fx } = setup();
    fx.getCurrentRate.mockResolvedValue(null as any);
    await svc.savePlan(null, { name: 'Flat', bountyPKR: 3000 });
    await svc.savePartner(SUPER, null, {
      name: 'Kamran',
      code: 'KAMRAN1',
      planId: String(plans.rows[0]._id),
    });
    expect(await svc.run()).toMatchObject({
      created: 0,
      skipped: expect.stringContaining('PKR exchange rate'),
    });
  });
});
