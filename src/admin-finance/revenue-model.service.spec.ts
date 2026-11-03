/* eslint-disable prettier/prettier */
import { RevenueModelService } from './revenue-model.service';

const q = (rows: any) => { const p: any = Promise.resolve(rows); p.select = () => p; p.lean = () => p; return p; };
const agg = (rows: any[]) => ({ aggregate: jest.fn(async () => rows) });
const NOW = Date.UTC(2026, 9, 30, 12);

describe('RevenueModelService', () => {
  it('combines every stream, converts commission and POS plans to USD, and discloses unknown currencies', async () => {
    const r: any = {
      platformPlanInvoiceModel: agg([{ _id: { m: '2026-10', s: 'st1' }, amount: 49 }, { _id: { m: '2026-09', s: 'st1' }, amount: 49 }]),
      transactionFeeBillModel: agg([{ _id: { m: '2026-10', s: 'st2' }, amount: 12 }]),
      platformAddonPurchaseModel: agg([{ _id: { m: '2026-10', s: 'st1' }, amount: 9 }]),
      transactionModel: agg([
        { _id: { m: '2026-10', s: 'st2', c: 'PKR' }, amount: 2800 },  // 2800 PKR at 280/USD = $10
        { _id: { m: '2026-10', s: 'st3', c: 'XYZ' }, amount: 500 },   // no rate: excluded and disclosed
      ]),
      posPurchaseModel: agg([{ _id: { m: '2026-10', s: 'st3', c: 'USD' }, amount: 20 }]),
      promotionRequestModel: agg([]),
      orderModel: agg([{ _id: '2026-10', gmv: 2000, orders: 40 }, { _id: '2026-09', gmv: 1000, orders: 20 }]),
      exchangeRateModel: agg([{ _id: 'PKR', ratePerUSD: 280 }]),
      storeModel: { find: jest.fn(() => q([{ _id: 'st1', name: 'Bloom', sellerId: 'se1' }, { _id: 'st2', name: 'Quiet', sellerId: 'se2' }, { _id: 'st3', name: 'Kite', sellerId: 'se3' }])) },
    };
    const { data } = await new RevenueModelService({ repositories: r } as any).getRevenueModel(3, NOW);
    const oct = data.monthly.find((m: any) => m.month === '2026-10');
    expect(oct.streams).toEqual({ plans: 49, transactionFees: 12, commission: 10, addons: 9, posPlans: 20, promotions: 0 });
    expect(oct).toMatchObject({ total: 100, transactional: 22, gmv: 2000, takeRatePercent: 5, transactionalTakeRatePercent: 1.1 });
    expect(data.summary).toMatchObject({ totalRevenue: 149, totalGmv: 3000, takeRatePercent: 4.97, payingStores: 3, thisMonthSoFar: 100 });
    expect(data.summary.lastFullMonth).toEqual({ month: '2026-09', revenue: 49, takeRatePercent: 4.9 });
    expect(data.concentration.top[0]).toMatchObject({ storeName: 'Bloom', amount: 107, sellerId: 'se1' });
    expect(data.notes.unconvertedCurrencies).toEqual(['XYZ']);
    expect(data.monthly.map((m: any) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
  });
});
