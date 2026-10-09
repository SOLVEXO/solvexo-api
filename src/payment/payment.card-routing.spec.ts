/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { DatabaseService } from '../database/databaseservice';

const USER = 'buyer-1';
const STORE = 'store-A';

function checkoutDoc(over: Record<string, any> = {}) {
  return {
    _id: 'checkout-1', userId: USER, status: 'pending', expiredAt: null, currency: 'USD', totalAmount: 120, fxSnapshots: [],
    items: [{ type: 'digital', storeId: STORE, variantId: 'v1', productId: 'p1', quantity: 1, name: 'E-book', totalPrice: 100, taxUSD: 5, currency: 'USD' }],
    ...over,
  };
}

function setup(opts: { connect?: string | null; checkout?: any } = {}) {
  const connect = opts.connect === undefined ? 'acct_seller' : opts.connect;
  const checkoutModel = {
    findOne: jest.fn().mockResolvedValue(opts.checkout ?? checkoutDoc()),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const paymentTransactionModel = { findOne: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}), findByIdAndUpdate: jest.fn() };
  const productVariantModel = { findOne: jest.fn().mockResolvedValue({ stock: 10, committedStock: 0, unlimitedStock: false }) };
  const storeModel = {
    find: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) }),
    findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ paymentCaptureMethod: 'automatic' }) }) }),
  };
  const db = { repositories: { checkoutModel, paymentTransactionModel, productVariantModel, storeModel } } as unknown as DatabaseService;
  const stripeConnect = { getEligibleConnectAccountForStore: jest.fn().mockResolvedValue(connect) };
  const commissionRules = { cardApplicationFeeCents: jest.fn().mockResolvedValue(468) };
  const exchange = { convertWithSnapshots: jest.fn().mockImplementation((a: number) => a) };

  const service = new PaymentService(
    db, { notify: jest.fn() } as any, { get: jest.fn().mockReturnValue('sk_test_dummy') } as any, {} as any, {} as any,
    {} as any, exchange as any, { log: jest.fn() } as any, {} as any, stripeConnect as any, commissionRules as any, {} as any, {} as any, {} as any, {} as any, {} as any,
  );
  const piCreate = jest.fn().mockResolvedValue({ id: 'pi_1', client_secret: 'secret_1' });
  (service as any).stripe.paymentIntents.create = piCreate;
  return { service, piCreate, stripeConnect, commissionRules, paymentTransactionModel };
}

describe('PaymentService.initiatePayment — buyer card payments go ONLY to the seller\'s connected account', () => {
  it('charges via a destination charge to the seller (with the pass-through application fee) and records settledViaConnect', async () => {
    const { service, piCreate, paymentTransactionModel, commissionRules } = setup();

    const res = await service.initiatePayment(USER, { checkoutId: 'checkout-1' });

    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 12000, transfer_data: { destination: 'acct_seller' }, application_fee_amount: 468 }),
      expect.anything(),
    );
    expect(commissionRules.cardApplicationFeeCents).toHaveBeenCalledWith(STORE, 12000, 'USD');
    expect(paymentTransactionModel.create).toHaveBeenCalledWith(expect.objectContaining({ settledViaConnect: true, stripeConnectedAccountId: 'acct_seller' }));
    expect(res.data.clientSecret).toBe('secret_1');
  });

  it('REGRESSION: a seller with no eligible connected account cannot take card payments — nothing is ever charged to the platform account', async () => {
    const { service, piCreate, paymentTransactionModel } = setup({ connect: null });

    await expect(service.initiatePayment(USER, { checkoutId: 'checkout-1' })).rejects.toThrow(/hasn't set up online card payments/);

    expect(piCreate).not.toHaveBeenCalled();
    expect(paymentTransactionModel.create).not.toHaveBeenCalled();
  });

  it('REGRESSION: a multi-store checkout cannot be paid by card (one destination account per charge)', async () => {
    const { service, piCreate } = setup({
      checkout: checkoutDoc({
        items: [
          { type: 'digital', storeId: 'store-A', variantId: 'v1', quantity: 1, name: 'A', totalPrice: 50, currency: 'USD' },
          { type: 'digital', storeId: 'store-B', variantId: 'v2', quantity: 1, name: 'B', totalPrice: 50, currency: 'USD' },
        ],
      }),
    });

    await expect(service.initiatePayment(USER, { checkoutId: 'checkout-1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(piCreate).not.toHaveBeenCalled();
  });

  it('REGRESSION: the digital part of a "split" checkout is ALSO paid to the seller (it used to fall back to the platform account)', async () => {
    const { service, piCreate } = setup({
      checkout: checkoutDoc({
        totalAmount: 205,
        items: [
          { type: 'physical', storeId: STORE, variantId: 'v1', productId: 'p1', quantity: 1, name: 'Mug', totalPrice: 80, taxUSD: 0, currency: 'USD' },
          { type: 'digital', storeId: STORE, variantId: 'v2', productId: 'p2', quantity: 1, name: 'E-book', totalPrice: 100, taxUSD: 5, currency: 'USD' },
        ],
      }),
    });

    await service.initiatePayment(USER, { checkoutId: 'checkout-1', paymentMode: 'split' });

    // only the digital item (100 + its 5 tax) is charged online now, routed to the seller
    expect(piCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10500, transfer_data: { destination: 'acct_seller' } }),
      expect.anything(),
    );
  });
});
