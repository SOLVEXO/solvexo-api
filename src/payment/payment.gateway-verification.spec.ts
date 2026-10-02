/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { DatabaseService } from '../database/databaseservice';

const SESSION = 'track_1';
const STORE = 'store-A';

function makeService(opts: { txn?: any; checkoutItems?: any[]; exchange?: any } = {}) {
  const paymentTransactionModel = { findOne: jest.fn().mockResolvedValue(opts.txn === undefined ? { checkoutId: 'checkout-1', amount: 200, currency: 'PKR' } : opts.txn) };
  const checkoutModel = {
    findOne: jest.fn().mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ items: opts.checkoutItems ?? [{ storeId: STORE }, { storeId: STORE }] }) }),
    }),
  };
  const db = { repositories: { paymentTransactionModel, checkoutModel } } as unknown as DatabaseService;
  const service = new PaymentService(
    db, { notify: jest.fn() } as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any,
    (opts.exchange ?? {}) as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  return { service, paymentTransactionModel, checkoutModel };
}

describe('PaymentService.assertGatewayPaymentMatches', () => {
  const base = { providerSessionId: SESSION, paymentType: 'safepay', storeId: STORE };

  it('passes when the session, store, amount and currency all match', async () => {
    const { service } = makeService();
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 200, paidCurrency: 'pkr' })).resolves.toBeUndefined();
  });

  it('passes when the gateway reports no amount/currency (nothing to compare)', async () => {
    const { service } = makeService();
    await expect(service.assertGatewayPaymentMatches(base)).resolves.toBeUndefined();
  });

  it('REGRESSION: rejects an unknown payment session (forged event for a session we never opened)', async () => {
    const { service } = makeService({ txn: null });
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 200 })).rejects.toThrow('Unknown payment session');
  });

  it('REGRESSION: rejects a session whose checkout belongs to a different store (cross-store forged webhook)', async () => {
    const { service } = makeService({ checkoutItems: [{ storeId: 'store-B' }] });
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 200 })).rejects.toThrow('does not belong to this store');
  });

  it('rejects a multi-store checkout (a single store gateway cannot settle it)', async () => {
    const { service } = makeService({ checkoutItems: [{ storeId: STORE }, { storeId: 'store-B' }] });
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 200 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REGRESSION: rejects an under-payment (paid less than the amount charged at initiate)', async () => {
    const { service } = makeService();
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 150, paidCurrency: 'PKR' })).rejects.toThrow('amount mismatch');
  });

  it('tolerates sub-cent float noise', async () => {
    const { service } = makeService();
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 200.004 })).resolves.toBeUndefined();
  });

  it('rejects a currency mismatch', async () => {
    const { service } = makeService();
    await expect(service.assertGatewayPaymentMatches({ ...base, paidAmount: 200, paidCurrency: 'USD' })).rejects.toThrow('currency mismatch');
  });
});

describe('PaymentService.computeGatewayCharge', () => {
  it('REGRESSION: charges the checkout FINAL total (incl. shipping + tax) converted into the gateway currency with frozen snapshots', async () => {
    const snapshots = [{ currency: 'USD', ratePerUSD: 1 }, { currency: 'PKR', ratePerUSD: 280 }];
    const exchange = {
      ensureCurrencyInSnapshots: jest.fn().mockResolvedValue(snapshots),
      convertWithSnapshots: jest.fn().mockImplementation((amount: number, from: string, to: string) => (from === 'USD' && to === 'PKR' ? amount * 280 : amount)),
    };
    const { service } = makeService({ exchange });

    // items 90 + shipping 6 + tax 4 = 100 USD payable
    const res = await service.computeGatewayCharge({ totalAmount: 100, currency: 'USD', fxSnapshots: [{ currency: 'USD', ratePerUSD: 1 }] }, 'PKR');

    expect(exchange.ensureCurrencyInSnapshots).toHaveBeenCalledWith([{ currency: 'USD', ratePerUSD: 1 }], 'PKR');
    expect(exchange.convertWithSnapshots).toHaveBeenCalledWith(100, 'USD', 'PKR', snapshots);
    expect(res).toEqual({ amount: 28000, fxSnapshots: snapshots });
  });

  it('is the identity when the checkout is already in the gateway currency', async () => {
    const exchange = {
      ensureCurrencyInSnapshots: jest.fn().mockResolvedValue([]),
      convertWithSnapshots: jest.fn().mockImplementation((amount: number) => amount),
    };
    const { service } = makeService({ exchange });
    const res = await service.computeGatewayCharge({ totalAmount: 1234.567, currency: 'PKR' }, 'PKR');
    expect(res.amount).toBe(1234.57);
  });
});
