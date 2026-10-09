/* eslint-disable prettier/prettier */
import { AdminFinanceService } from './admin-finance.service';
import { getPlatformEarnings } from '../common/platform-earnings.util';

function setup(opts: {
  plan?: any[]; paid?: any[]; open?: any[]; accrued?: any[]; rates?: any[]; addons?: any[];
} = {}) {
  const addonAgg = jest.fn().mockResolvedValue(opts.addons ?? []);
  const planAgg = jest.fn().mockResolvedValue(opts.plan ?? []);
  // two aggregates on the bill model: paid first, then open (Promise.all call order)
  const billAgg = jest.fn()
    .mockResolvedValueOnce(opts.paid ?? [])
    .mockResolvedValueOnce(opts.open ?? []);
  const txAgg = jest.fn().mockResolvedValue(opts.accrued ?? []);
  const rateAgg = jest.fn().mockResolvedValue(opts.rates ?? [{ _id: 'PKR', ratePerUSD: 280 }]);
  const db = {
    repositories: {
      platformPlanInvoiceModel: { aggregate: planAgg },
      transactionFeeBillModel: { aggregate: billAgg },
      transactionModel: { aggregate: txAgg },
      exchangeRateModel: { aggregate: rateAgg },
      platformAddonPurchaseModel: { aggregate: addonAgg },
    },
  } as any;
  const service = new AdminFinanceService(db, { isConnected: false } as any, {} as any, {} as any, {} as any);
  return { service, planAgg, billAgg, txAgg, addonAgg };
}

describe('AdminFinanceService.getPlatformRevenue (USD only; what sellers pay Solvexo)', () => {
  const query = { from: '2026-10-01', to: '2026-10-31' };

  it('reports plan revenue net of refunds plus collected transaction fees', async () => {
    const { service } = setup({
      plan: [{ _id: null, gross: 500, refunded: 29, count: 12 }],
      paid: [{ _id: null, total: 41.5, count: 3 }],
    });

    const { data } = await service.getPlatformRevenue(query);

    expect(data.currency).toBe('USD');
    expect(data.planRevenue).toEqual({ grossUSD: 500, refundedUSD: 29, netUSD: 471, invoiceCount: 12 });
    expect(data.transactionFees.collectedUSD).toBe(41.5);
    expect(data.transactionFees.billCount).toBe(3);
    expect(data.totalRevenueUSD).toBe(512.5);
  });

  it('counts add-on charges (purchases and renewals) in the range as platform revenue', async () => {
    const { service, addonAgg } = setup({
      plan: [{ _id: null, gross: 100, refunded: 0, count: 2 }],
      addons: [{ _id: null, total: 35, count: 4 }],
    });

    const { data } = await service.getPlatformRevenue(query);

    expect(data.addons).toEqual({ grossUSD: 35, chargeCount: 4 });
    expect(data.totalRevenueUSD).toBe(135);
    // per-charge dates, with a legacy fallback for purchases that predate the `charges` log
    const pipeline = addonAgg.mock.calls[0][0];
    expect(pipeline[0].$addFields._charges.$cond[2]).toEqual([{ amountUSD: '$priceUSD', chargedAt: '$createdAt' }]);
    expect(pipeline[2].$match['_charges.chargedAt']).toEqual({ $gte: expect.any(Date), $lte: expect.any(Date) });
  });

  it('REGRESSION: invoiced-but-unpaid and accrued-but-unbilled fees are shown but NOT counted as revenue', async () => {
    const { service } = setup({
      paid: [{ _id: null, total: 10, count: 1 }],
      open: [{ _id: null, total: 25, count: 2 }],
      accrued: [{ _id: 'USD', amount: 4 }, { _id: 'PKR', amount: 560 }], // 4 + 2 = $6
    });

    const { data } = await service.getPlatformRevenue(query);

    expect(data.transactionFees.invoicedUnpaidUSD).toBe(25);
    expect(data.transactionFees.accruedUnbilledUSD).toBe(6);
    expect(data.totalRevenueUSD).toBe(10);
  });

  it('discloses a currency with no known FX rate instead of guessing its USD value', async () => {
    const { service } = setup({ accrued: [{ _id: 'XYZ', amount: 100 }, { _id: 'USD', amount: 3 }] });

    const { data } = await service.getPlatformRevenue(query);

    expect(data.transactionFees.accruedUnbilledUSD).toBe(3);
    expect(data.transactionFees.unconvertibleCurrencies).toEqual(['XYZ']);
  });

  it('is all zeros for a platform with no revenue yet (never undefined/NaN)', async () => {
    const { service } = setup();
    const { data } = await service.getPlatformRevenue(query);
    expect(data.planRevenue.netUSD).toBe(0);
    expect(data.transactionFees.collectedUSD).toBe(0);
    expect(data.totalRevenueUSD).toBe(0);
  });

  it('queries only PAID bills by paidAt and only plan invoices that were actually paid', async () => {
    const { service, planAgg, billAgg } = setup();
    await service.getPlatformRevenue(query);
    expect(planAgg.mock.calls[0][0][0].$match.status).toEqual({ $in: ['paid', 'partially_refunded', 'refunded'] });
    expect(billAgg.mock.calls[0][0][0].$match.status).toBe('paid');
    expect(billAgg.mock.calls[1][0][0].$match.status).toEqual({ $in: ['invoiced', 'payment_failed'] });
  });
});

describe('getPlatformEarnings — direct-settled sales are not recognized as sale-time commission', () => {
  it('excludes settledDirectly sale rows (their fee is billed monthly and reported from TransactionFeeBill)', async () => {
    const aggregate = jest.fn().mockResolvedValue([]);
    const txModel: any = { aggregate };

    await getPlatformEarnings(txModel, new Date('2026-01-01'), new Date('2026-12-31'));

    expect(aggregate.mock.calls[0][0][0].$match).toEqual(expect.objectContaining({ type: 'sale', 'metadata.settledDirectly': { $ne: true } }));
  });
});
