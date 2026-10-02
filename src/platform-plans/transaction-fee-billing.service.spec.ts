/* eslint-disable prettier/prettier */
import { TransactionFeeBillingService, MIN_BILLABLE_USD } from './transaction-fee-billing.service';
import { DatabaseService } from '../database/databaseservice';

const STORE = 'store-1';
const SELLER = 'seller-1';
const NOW = new Date(Date.UTC(2026, 10, 1, 4, 0, 0)); // 1 Nov 2026 — bills October

function setup(opts: {
  rows?: Array<{ _id: string; amount: number; count: number }>;
  existingBill?: any;
  seller?: any;
  stripe?: any | null;
  convert?: (amount: number, from: string, to: string) => Promise<number>;
} = {}) {
  const rows = opts.rows ?? [{ _id: 'USD', amount: 12.34, count: 4 }];
  const txModel = {
    distinct: jest.fn().mockResolvedValue([STORE]),
    aggregate: jest.fn().mockResolvedValue(rows),
    find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'tx1' }, { _id: 'tx2' }]) }) }),
    updateMany: jest.fn().mockResolvedValue({}),
  };
  const bill = { _id: 'bill-1' };
  const billModel = {
    findOne: jest.fn().mockResolvedValue(opts.existingBill ?? null),
    findOneAndUpdate: jest.fn().mockResolvedValue(bill),
    updateOne: jest.fn().mockResolvedValue({}),
    find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) }),
  };
  const storeModel = { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ sellerId: SELLER, name: 'S' }) }) }) };
  const sellerModel = { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(opts.seller === undefined ? { stripeCustomerId: 'cus_1' } : opts.seller) }) }) };
  const stripe = opts.stripe === undefined
    ? {
        invoiceItems: { create: jest.fn().mockResolvedValue({}) },
        invoices: {
          create: jest.fn().mockResolvedValue({ id: 'in_1' }),
          finalizeInvoice: jest.fn().mockResolvedValue({ id: 'in_1', status: 'open', hosted_invoice_url: 'https://stripe.test/in_1' }),
          pay: jest.fn().mockResolvedValue({ id: 'in_1', status: 'paid', hosted_invoice_url: 'https://stripe.test/in_1' }),
        },
      }
    : opts.stripe;
  const db = { repositories: { transactionModel: txModel, transactionFeeBillModel: billModel, storeModel, sellerModel } } as unknown as DatabaseService;
  const exchange = { convert: jest.fn().mockImplementation(opts.convert ?? (async (a: number) => a / 280)) };
  const activity = { log: jest.fn() };
  const service = new TransactionFeeBillingService(db, { stripeClient: stripe } as any, exchange as any, activity as any);
  return { service, txModel, billModel, stripe, exchange, activity };
}

describe('TransactionFeeBillingService.billAccruedFees', () => {
  it('bills last month\'s accrued fees as ONE Stripe invoice and records a paid bill', async () => {
    const { service, stripe, billModel, txModel } = setup();

    const result = await service.billAccruedFees(NOW);

    expect(result).toEqual({ stores: 1, billed: 1, carried: 0, skipped: 0, failed: 0 });
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', amount: 1234, currency: 'usd' }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining('txfee-item-bill-1') }),
    );
    expect(stripe.invoices.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_1', pending_invoice_items_behavior: 'include', metadata: expect.objectContaining({ purpose: 'transaction_fees', storeId: STORE }) }),
      expect.anything(),
    );
    expect(stripe.invoices.pay).toHaveBeenCalledWith('in_1');
    expect(billModel.findOneAndUpdate).toHaveBeenCalledWith({ storeId: STORE, periodKey: '2026-10' }, expect.anything(), expect.anything());
    expect(billModel.updateOne).toHaveBeenCalledWith({ _id: 'bill-1' }, { $set: expect.objectContaining({ status: 'paid', stripeInvoiceId: 'in_1' }) });
    // the covered fee rows are claimed so a rerun can't bill them again
    expect(txModel.updateMany).toHaveBeenCalledWith(
      { _id: { $in: ['tx1', 'tx2'] }, 'metadata.billing.status': 'pending_invoice' },
      { $set: { 'metadata.billing.status': 'invoiced', 'metadata.billing.billId': 'bill-1' } },
    );
  });

  it('only bills fees accrued BEFORE the current month starts (this month\'s accrual waits)', async () => {
    const { service, txModel } = setup();
    await service.billAccruedFees(NOW);
    expect(txModel.distinct).toHaveBeenCalledWith('storeId', expect.objectContaining({ createdAt: { $lt: new Date(Date.UTC(2026, 10, 1)) } }));
  });

  it('converts non-USD fees to USD at billing time', async () => {
    const { service, stripe, exchange } = setup({ rows: [{ _id: 'PKR', amount: 2800, count: 10 }], convert: async (a) => a / 280 });
    await service.billAccruedFees(NOW);
    expect(exchange.convert).toHaveBeenCalledWith(2800, 'PKR', 'USD');
    expect(stripe.invoiceItems.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000 }), expect.anything()); // $10.00
  });

  it('REGRESSION: a total under Stripe\'s $0.50 minimum is carried over, never billed', async () => {
    const { service, stripe } = setup({ rows: [{ _id: 'USD', amount: MIN_BILLABLE_USD - 0.01, count: 1 }] });
    const result = await service.billAccruedFees(NOW);
    expect(result.carried).toBe(1);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
  });

  it('is idempotent: a store already billed for the month is skipped', async () => {
    const { service, stripe } = setup({ existingBill: { status: 'paid' } });
    const result = await service.billAccruedFees(NOW);
    expect(result.skipped).toBe(1);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
  });

  it('leaves fees pending (and says so in the activity log) when the seller has no billing customer yet', async () => {
    const { service, stripe, activity, billModel } = setup({ seller: { stripeCustomerId: null } });
    const result = await service.billAccruedFees(NOW);
    expect(result.skipped).toBe(1);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
    expect(billModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(activity.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'transaction_fee_billing_skipped' }));
  });

  it('records payment_failed (not paid) when Stripe cannot collect, keeping the invoice for Stripe\'s own retries', async () => {
    const { service, stripe, billModel } = setup();
    stripe.invoices.pay.mockRejectedValue(new Error('Your card was declined.'));
    const result = await service.billAccruedFees(NOW);
    expect(result.billed).toBe(1);
    expect(billModel.updateOne).toHaveBeenCalledWith({ _id: 'bill-1' }, { $set: expect.objectContaining({ status: 'payment_failed', failureReason: 'Your card was declined.', stripeInvoiceId: 'in_1' }) });
  });

  it('REGRESSION: if the invoice cannot be created at all, the fee rows go back to pending so the next run retries', async () => {
    const { service, stripe, txModel, billModel } = setup();
    stripe.invoiceItems.create.mockRejectedValue(new Error('Stripe is down'));
    const result = await service.billAccruedFees(NOW);
    expect(result.failed).toBe(1);
    expect(txModel.updateMany).toHaveBeenLastCalledWith(
      { 'metadata.billing.billId': 'bill-1' },
      { $set: { 'metadata.billing.status': 'pending_invoice' }, $unset: { 'metadata.billing.billId': '' } },
    );
    expect(billModel.updateOne).toHaveBeenCalledWith({ _id: 'bill-1' }, { $set: expect.objectContaining({ status: 'failed' }) });
  });

  it('skips a store whose currency has no FX rate instead of guessing', async () => {
    const { service, stripe } = setup({ rows: [{ _id: 'XYZ', amount: 100, count: 3 }], convert: async () => { throw new Error('no rate'); } });
    const result = await service.billAccruedFees(NOW);
    expect(result.skipped).toBe(1);
    expect(stripe.invoiceItems.create).not.toHaveBeenCalled();
  });
});

describe('TransactionFeeBillingService — invoice webhooks and overview', () => {
  it('marks the bill paid when Stripe reports its invoice paid (and ignores unrelated invoices)', async () => {
    const { service, billModel } = setup();
    await service.handleInvoicePaid({ id: 'in_1', metadata: { purpose: 'transaction_fees' } });
    expect(billModel.updateOne).toHaveBeenCalledWith({ stripeInvoiceId: 'in_1' }, { $set: expect.objectContaining({ status: 'paid' }) });

    billModel.updateOne.mockClear();
    await service.handleInvoicePaid({ id: 'in_2', metadata: {} });
    await service.handleInvoicePaid({ id: 'in_3', subscription: 'sub_1' });
    expect(billModel.updateOne).not.toHaveBeenCalled();
  });

  it('marks the bill payment_failed when Stripe reports the invoice failed', async () => {
    const { service, billModel } = setup();
    await service.handleInvoiceFailed({ id: 'in_1', metadata: { purpose: 'transaction_fees' } });
    expect(billModel.updateOne).toHaveBeenCalledWith({ stripeInvoiceId: 'in_1' }, { $set: expect.objectContaining({ status: 'payment_failed' }) });
  });

  it('getOverview reports what has accrued (native + estimated USD) and the next billing date', async () => {
    const { service } = setup({ rows: [{ _id: 'PKR', amount: 560, count: 5 }], convert: async (a) => a / 280 });
    const overview = await service.getOverview(STORE, NOW);
    expect(overview.accrued.byCurrency).toEqual([{ currency: 'PKR', amount: 560, saleCount: 5 }]);
    expect(overview.accrued.estimatedUSD).toBe(2);
    expect(overview.accrued.saleCount).toBe(5);
    expect(overview.accrued.nextBillingDate).toEqual(new Date(Date.UTC(2026, 11, 1)));
    expect(overview.bills).toEqual([]);
  });
});
