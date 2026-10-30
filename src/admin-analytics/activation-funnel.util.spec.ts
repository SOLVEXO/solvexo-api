/* eslint-disable prettier/prettier */
import { type MerchantJourney, funnel, funnelByCohort, funnelBySource, furthestStep, stuckMerchants } from './activation-funnel.util';

const NOW = new Date('2026-10-30T12:00:00Z').getTime();
const D = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();
const m = (id: string, o: Partial<MerchantJourney>): MerchantJourney => ({
  sellerId: id, name: id, email: `${id}@x.test`, source: null, signedUpAt: D('2026-10-01'), verified: true,
  storeAt: null, productAt: null, saleAt: null, paidAt: null, ...o,
});
const all = [
  m('a', { storeAt: D('2026-10-01'), productAt: D('2026-10-03'), saleAt: D('2026-10-11'), paidAt: D('2026-10-15'), source: 'google' }),
  m('b', { storeAt: D('2026-10-02'), productAt: D('2026-10-05'), saleAt: D('2026-10-21'), source: 'google' }),
  m('c', { storeAt: D('2026-10-02'), source: 'facebook' }),
  m('d', { verified: false, signedUpAt: D('2026-09-10') }),
];

describe('activation funnel', () => {
  it('counts each step, conversion from the step before, and median days from sign-up', () => {
    const rows = funnel(all);
    expect(rows.map((r) => [r.step, r.merchants, r.percentOfSignups, r.percentOfPrevious, r.medianDaysFromSignup])).toEqual([
      ['signed_up', 4, 100, null, null], ['verified', 3, 75, 75, null], ['store', 3, 75, 100, 1],
      ['product', 2, 50, 66.7, 3], ['sale', 2, 50, 100, 15], ['paying', 1, 25, 50, 14],
    ]);
  });

  it('by sign-up month and by channel', () => {
    expect(funnelByCohort(all, ['2026-09', '2026-10']).map((r) => [r.month, r.signups, r.percent.store, r.percent.sale])).toEqual([['2026-09', 1, 0, 0], ['2026-10', 3, 100, 66.7]]);
    expect(funnelBySource(all)).toEqual([
      { source: 'google', signups: 2, storePercent: 100, salePercent: 100, payingPercent: 50 },
      { source: 'facebook', signups: 1, storePercent: 100, salePercent: 0, payingPercent: 0 },
      { source: 'Direct / unknown', signups: 1, storePercent: 0, salePercent: 0, payingPercent: 0 },
    ]);
  });

  it('furthest step stops at the first gap', () => {
    expect(furthestStep(m('x', { storeAt: 1, saleAt: 2 }))).toBe('store'); // sale without a product doesn't skip ahead
    expect(furthestStep(m('y', { verified: false, storeAt: 1 }))).toBe('signed_up');
  });

  it('stuck list: recent, not paying, stalled 3+ days, longest first', () => {
    const list = stuckMerchants([
      ...all,
      m('fresh', { signedUpAt: NOW - 86_400_000 }),           // 1 day: not stuck yet
      m('old', { signedUpAt: D('2026-06-01') }),              // outside 60 days
    ], NOW);
    expect(list.map((x) => [x.sellerId, x.stuckAt, x.nextStep, x.daysStuck])).toEqual([
      ['d', 'signed_up', 'verified', 50], ['c', 'store', 'product', 28], ['b', 'sale', 'paying', 9],
    ]);
  });
});

describe('activation funnel — step order', () => {
  it('a plan bought before any sale is not counted as Paying in the funnel, so each step is a subset of the last', () => {
    const ms = [m('p', { storeAt: 1, productAt: 2, paidAt: 3 }), m('q', { storeAt: 1, productAt: 2, saleAt: 4, paidAt: 5 })];
    const rows = funnel(ms);
    expect(rows.map((r) => r.merchants)).toEqual([2, 2, 2, 2, 1, 1]);
    for (let i = 1; i < rows.length; i++) expect(rows[i].merchants).toBeLessThanOrEqual(rows[i - 1].merchants);
    expect(funnelBySource(ms)[0].payingPercent).toBe(50);
  });
});
