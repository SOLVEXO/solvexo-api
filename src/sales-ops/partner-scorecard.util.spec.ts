/* eslint-disable prettier/prettier */
import { DEFAULT_PROGRAMME_SETTINGS } from './partner-programme.util';
import { monthlyTrend, pilotMilestones, scorecard, type ScoreInput } from './partner-scorecard.util';

const now = new Date('2026-11-22T00:00:00Z');
const seller = (id: string, o: Partial<{ creditedAt: string; firstPaidAt: string | null; payingNow: boolean; liveStore: boolean }> = {}) => ({
  sellerId: id, creditedAt: new Date(o.creditedAt ?? '2026-06-01'), firstPaidAt: o.firstPaidAt ? new Date(o.firstPaidAt) : null,
  payingNow: o.payingNow ?? false, liveStore: o.liveStore ?? false,
});
const input = (o: Partial<ScoreInput> = {}): ScoreInput => ({
  now, startedAt: new Date('2026-06-01'), sellers: [], registrations: [], complaints: [], certifiedStaff: 0, tier: 'registered', earnedPKR: 0, ...o,
});

describe('partner scorecard (B13)', () => {
  it('measures quality as well as volume: retention after 3 months, time to first sale, complaint rate', () => {
    const c = scorecard(input({
      sellers: [
        seller('a', { firstPaidAt: '2026-06-11', payingNow: true, liveStore: true }), // 10 days after start
        seller('b', { firstPaidAt: '2026-07-01', payingNow: false, liveStore: true }), // matured, churned
        seller('c', { firstPaidAt: '2026-11-01', payingNow: true }), // too recent for retention
        seller('d'),
      ],
      registrations: [
        { submittedAt: new Date('2026-06-05'), status: 'won', demoHeld: true },
        { submittedAt: new Date('2026-07-05'), status: 'rejected', demoHeld: false },
        { submittedAt: new Date('2026-08-05'), status: 'accepted', demoHeld: false },
      ],
      complaints: [new Date('2026-09-01')],
    }), DEFAULT_PROGRAMME_SETTINGS);
    expect(c).toMatchObject({
      prospects: 3, registrationsAccepted: 2, demos: 1, signups: 4, liveStores: 2, payingNow: 2, everPaid: 3,
      retention3mPercent: 50, retentionBase: 2, daysToFirstSale: 10, complaints: 1, complaintRatePercent: 50,
    });
  });

  it('says when a partner qualifies for a higher tier, or falls below theirs', () => {
    const many = (n: number) => Array.from({ length: n }, (_, k) => seller(`s${k}`, { firstPaidAt: '2026-10-01', payingNow: true }));
    expect(scorecard(input({ sellers: many(30) }), DEFAULT_PROGRAMME_SETTINGS)).toMatchObject({ eligibleTier: 'silver', tierStatus: 'eligible_for_higher' });
    expect(scorecard(input({ sellers: many(30), tier: 'gold' }), DEFAULT_PROGRAMME_SETTINGS)).toMatchObject({ tierStatus: 'below_requirement' });
    expect(scorecard(input({ sellers: many(3), tier: 'regional' }), DEFAULT_PROGRAMME_SETTINGS).tierStatus).toBe('meets');
  });

  it('leaves milestones undecided until management sets X, Y and Z, then checks them', () => {
    const c = scorecard(input({ sellers: [seller('a', { payingNow: true, liveStore: true, firstPaidAt: '2026-10-01' })] }), DEFAULT_PROGRAMME_SETTINGS);
    expect(pilotMilestones(c, DEFAULT_PROGRAMME_SETTINGS).map((m) => m.met)).toEqual([null, null, null]);
    const set = { ...DEFAULT_PROGRAMME_SETTINGS, pilotMinPayingSellers: 1, pilotMinLiveStores: 2, pilotMaxComplaintRatePercent: 5 };
    expect(pilotMilestones(c, set).map((m) => m.met)).toEqual([true, false, true]);
  });

  it('counts each of the last 6 months', () => {
    const t = monthlyTrend({ now, sellers: [seller('a', { creditedAt: '2026-11-03', firstPaidAt: '2026-11-10' })], registrations: [{ submittedAt: new Date('2026-09-15'), status: 'won', demoHeld: false }] });
    expect(t.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(t[3].registrations).toBe(1);
    expect(t[5]).toMatchObject({ signups: 1, firstPayments: 1 });
  });
});
