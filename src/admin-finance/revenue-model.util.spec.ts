/* eslint-disable prettier/prettier */
import { buildMonths, concentration, monthKeys, summarizeStreams } from './revenue-model.util';

const empty = { plans: [], transactionFees: [], commission: [], addons: [], posPlans: [], promotions: [] };

describe('revenue model', () => {
  it('adds streams per month and computes the take rate against GMV', () => {
    const months = buildMonths(['2026-09', '2026-10'], {
      ...empty,
      plans: [{ month: '2026-09', amount: 100 }, { month: '2026-10', amount: 120 }],
      commission: [{ month: '2026-10', amount: 50 }, { month: '2026-10', amount: 10 }],
      transactionFees: [{ month: '2026-10', amount: 20 }],
    }, [{ month: '2026-10', gmv: 4000, orders: 80 }]);
    expect(months[0]).toMatchObject({ total: 100, subscription: 100, transactional: 0, gmv: 0, takeRatePercent: null });
    expect(months[1]).toMatchObject({ total: 200, transactional: 80, subscription: 120, gmv: 4000, orders: 80, takeRatePercent: 5, transactionalTakeRatePercent: 2 });
  });

  it('compares the last two FULL months (the current month is partial)', () => {
    const months = buildMonths(['2026-08', '2026-09', '2026-10'], {
      ...empty,
      plans: [{ month: '2026-08', amount: 100 }, { month: '2026-09', amount: 150 }, { month: '2026-10', amount: 5 }],
      addons: [{ month: '2026-09', amount: 50 }],
    }, []);
    const s = summarizeStreams(months);
    expect(s[0]).toMatchObject({ stream: 'plans', total: 255, sharePercent: 83.61, lastMonth: 150, previousMonth: 100, changePercent: 50 });
    expect(s.find((x) => x.stream === 'addons')).toMatchObject({ total: 50, changePercent: null }); // nothing to compare against
  });

  it('measures how much revenue the biggest stores make up', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({ storeId: `s${i}`, amount: 10 })),
      { storeId: 's0', amount: 80 }, { storeId: '', amount: 999 }, { storeId: 'refunded', amount: -5 },
    ];
    const c = concentration(rows);
    expect(c.payingStores).toBe(12);
    expect(c.top[0]).toEqual({ storeId: 's0', amount: 90, sharePercent: 45 });
    expect(c.top).toHaveLength(10);
    expect(c.top10SharePercent).toBe(90);
  });

  it('month keys end at the current month', () => {
    expect(monthKeys(3, Date.UTC(2026, 0, 15))).toEqual(['2025-11', '2025-12', '2026-01']);
  });
});
