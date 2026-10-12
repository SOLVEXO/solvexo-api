/* eslint-disable prettier/prettier */
import { AdminFinanceService } from './admin-finance.service';

const chain = (value: any) => {
  const c: any = {};
  for (const m of ['sort', 'select', 'limit']) c[m] = () => c;
  c.lean = () => Promise.resolve(value);
  return c;
};

function setup(opts: { firstPlacement?: any; orders?: any[]; sales?: any[] }) {
  const transactionModel = {
    findOne: jest.fn().mockReturnValue(chain(opts.firstPlacement ?? null)),
    find: jest.fn().mockReturnValue(chain(opts.sales ?? [])),
  };
  const orderModel = { find: jest.fn().mockReturnValue(chain(opts.orders ?? [])) };
  const db = { repositories: { transactionModel, orderModel } } as any;
  const service = new AdminFinanceService(db, { isConnected: false } as any, {} as any, {} as any, {} as any);
  return { service, transactionModel, orderModel };
}

const recentPlacement = { createdAt: new Date(Date.now() - 3 * 3600_000) };
const order = (id: string, extra: any = {}) => ({
  _id: id, currency: 'PKR', paymentType: 'cash_on_delivery',
  sellerOrders: [{ storeId: 's1', sellerId: 'u1', status: 'pending', subtotal: 900, taxAmount: 100, settlementAmount: 1000, settlementCurrency: 'PKR', ...extra }],
});

describe('AdminFinanceService.getReconciliation (orders vs finance ledger sales)', () => {
  it('has nothing to reconcile before any sale was recorded at placement (no false alarm right after deploy)', async () => {
    const { service, orderModel } = setup({ firstPlacement: null, orders: [order('o1')] });

    const { data } = await service.getReconciliation(1);

    expect(data.hasAnyDiscrepancy).toBe(false);
    expect(data.byCurrency).toEqual([]);
    expect(orderModel.find).not.toHaveBeenCalled();
  });

  it('is clean when every directly-settled order has its sale with the same amount', async () => {
    const { service } = setup({
      firstPlacement: recentPlacement,
      orders: [order('o1'), order('o2')],
      sales: [{ storeId: 's1', referenceId: 'o1', amount: 1000 }, { storeId: 's1', referenceId: 'o2', amount: 1000 }],
    });

    const { data } = await service.getReconciliation(1);

    expect(data.hasAnyDiscrepancy).toBe(false);
    expect(data.byCurrency[0]).toMatchObject({ currency: 'PKR', orderCount: 2, expectedSales: 2000, ledgerSales: 2000, drift: 0, missingSaleCount: 0 });
  });

  it('flags an order whose sale is missing from the ledger, and one recorded with a different amount', async () => {
    const { service } = setup({
      firstPlacement: recentPlacement,
      orders: [order('o1'), order('o2')],
      sales: [{ storeId: 's1', referenceId: 'o2', amount: 800 }], // o1 missing, o2 wrong amount
    });

    const { data } = await service.getReconciliation(1);

    expect(data.hasAnyDiscrepancy).toBe(true);
    expect(data.byCurrency[0]).toMatchObject({ missingSaleCount: 1, mismatchedSaleCount: 1, expectedSales: 2000, ledgerSales: 800, drift: 1200 });
  });

  it('does not expect a platform-held (card, not Connect) order to be in the ledger until it is completed', async () => {
    const { service } = setup({
      firstPlacement: recentPlacement,
      orders: [{ ...order('o1'), paymentType: 'stripe' }],
      sales: [],
    });

    const { data } = await service.getReconciliation(1);

    expect(data.hasAnyDiscrepancy).toBe(false);
  });
});
