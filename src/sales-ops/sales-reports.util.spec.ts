/* eslint-disable prettier/prettier */
import {
  campaignCode,
  campaignResults,
  currentMonth,
  leaderboard,
  monthRange,
  untrackedCodes,
} from './sales-reports.util';

const camp = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  code: 'eid-sale',
  name: 'Eid sale',
  channel: 'facebook',
  budgetPKR: 100000,
  startDate: null,
  endDate: null,
  isArchived: false,
  spend: [{ amountPKR: 40000 }, { amountPKR: 20000 }],
  ...over,
});

describe('campaign results', () => {
  it('counts leads, sign-ups (own tag or via a lead, once each), trials, paying and cost per paying customer', () => {
    const leads = [
      { id: 'l1', campaign: 'Eid-Sale', stage: 'won', sellerId: 's1' },
      { id: 'l2', campaign: 'eid-sale', stage: 'new', sellerId: null },
      { id: 'l3', campaign: 'eid-sale', stage: 'trial', sellerId: 's2' },
      { id: 'l4', campaign: 'other', stage: 'new', sellerId: null },
    ];
    const merchants = [
      {
        sellerId: 's1',
        campaign: 'eid-sale',
        trialed: true,
        paid: true,
        mrrUSD: 10,
      }, // tagged AND via lead: once
      { sellerId: 's2', campaign: null, trialed: true, paid: false, mrrUSD: 0 }, // via lead only
      {
        sellerId: 's3',
        campaign: 'EID-SALE',
        trialed: false,
        paid: true,
        mrrUSD: 0,
      }, // paid once, churned
      {
        sellerId: 's4',
        campaign: 'summer',
        trialed: false,
        paid: false,
        mrrUSD: 0,
      },
    ];
    const [r] = campaignResults([camp()], leads, merchants, 280);
    expect(r).toMatchObject({
      spendPKR: 60000,
      leads: 3,
      wonLeads: 1,
      signups: 3,
      trials: 2,
      paying: 2,
      payingNow: 1,
      mrrUSD: 10,
      mrrPKR: 2800,
      costPerLeadPKR: 20000,
      costPerSignupPKR: 20000,
      costPerPayingPKR: 30000,
      paybackMonths: 21.4,
    });
  });

  it('leaves costs empty when nothing was spent or nothing came of it, and PKR empty without a rate', () => {
    const [r] = campaignResults([camp({ spend: [] })], [], [], null);
    expect(r).toMatchObject({
      spendPKR: 0,
      costPerLeadPKR: null,
      costPerPayingPKR: null,
      mrrPKR: null,
      paybackMonths: null,
    });
  });

  it('lists campaign codes in use that no campaign tracks', () => {
    expect(
      untrackedCodes(
        ['eid-sale'],
        [{ id: 'a', campaign: 'Summer', stage: 'new', sellerId: null }],
        [
          {
            sellerId: 's',
            campaign: 'summer',
            trialed: false,
            paid: false,
            mrrUSD: 0,
          },
          {
            sellerId: 't',
            campaign: 'eid-sale',
            trialed: false,
            paid: false,
            mrrUSD: 0,
          },
        ],
      ),
    ).toEqual([{ code: 'summer', leads: 1, signups: 1 }]);
  });

  it('makes a link-safe code from a name', () => {
    expect(campaignCode('Eid Sale 2026 — Lahore!')).toBe(
      'eid-sale-2026-lahore',
    );
  });
});

describe('team', () => {
  it('uses Pakistan-time months', () => {
    expect(monthRange('2026-11')).toEqual({
      from: new Date('2026-10-31T19:00:00.000Z'),
      to: new Date('2026-11-30T19:00:00.000Z'),
    });
    expect(currentMonth(Date.parse('2026-11-30T20:00:00Z'))).toBe('2026-12');
  });

  it('ranks reps by won value, with win rate and progress against targets', () => {
    const rows = leaderboard(
      [
        { adminId: 'a', name: 'Atiq' },
        { adminId: 'b', name: 'Bilal' },
      ],
      {
        newLeads: [
          { ownerAdminId: 'a' },
          { ownerAdminId: 'b' },
          { ownerAdminId: 'b' },
        ],
        activities: [
          { adminId: 'b' },
          { adminId: 'b' },
          { adminId: 'a' },
          { adminId: null },
        ],
        demos: [{ ownerAdminId: 'b' }],
        closed: [
          { ownerAdminId: 'b', stage: 'won', dealValuePKR: 60000 },
          { ownerAdminId: 'b', stage: 'lost', dealValuePKR: 10000 },
          { ownerAdminId: 'a', stage: 'won', dealValuePKR: 30000 },
        ],
        open: [
          { ownerAdminId: 'a', dealValuePKR: 50000, overdue: true },
          { ownerAdminId: 'a', dealValuePKR: null, overdue: false },
        ],
      },
      [{ adminId: 'b', wonDeals: 4, wonValuePKR: 50000, activities: null }],
    );
    expect(rows.map((r) => r.name)).toEqual(['Bilal', 'Atiq']);
    expect(rows[0]).toMatchObject({
      newLeads: 2,
      activities: 2,
      demos: 1,
      won: 1,
      lost: 1,
      winRate: 50,
      wonValuePKR: 60000,
      progress: { wonDeals: 25, wonValuePKR: 100, activities: null },
    });
    expect(rows[1]).toMatchObject({
      openLeads: 2,
      openValuePKR: 50000,
      overdue: 1,
      winRate: 100,
      target: null,
    });
  });
});
