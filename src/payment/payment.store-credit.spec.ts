/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';

function makeService(checkout: any, storeCredit: any = {}) {
  const checkoutModel = { findOne: jest.fn().mockResolvedValue(checkout), findByIdAndUpdate: jest.fn() };
  const db: any = { repositories: { checkoutModel } };
  const service = new PaymentService(
    db, { notify: jest.fn() } as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any,
    {} as any, { log: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    storeCredit as any,
  );
  return { service, checkoutModel };
}

const applied = { userId: 'u1', storeCreditApplied: true, storeCreditStoreId: 'store-1', storeCreditDiscountTotalUSD: 12.5 };

describe('PaymentService store credit', () => {
  it('assertStoreCreditStillCovers does nothing when no credit is applied', async () => {
    const assertCovers = jest.fn();
    const { service } = makeService(null, { assertCovers });
    await service.assertStoreCreditStillCovers({ userId: 'u1', storeCreditApplied: false });
    await service.assertStoreCreditStillCovers({ userId: 'u1', storeCreditApplied: true, storeCreditStoreId: 'store-1', storeCreditDiscountTotalUSD: 0 });
    expect(assertCovers).not.toHaveBeenCalled();
  });

  it('assertStoreCreditStillCovers checks the applied amount against the buyer\'s balance in that store', async () => {
    const assertCovers = jest.fn().mockResolvedValue(undefined);
    const { service } = makeService(null, { assertCovers });
    await service.assertStoreCreditStillCovers(applied);
    expect(assertCovers).toHaveBeenCalledWith('store-1', 'u1', 12.5);
  });

  it('assertStoreCreditStillCovers propagates the "balance changed" error so no payment is taken', async () => {
    const assertCovers = jest.fn().mockRejectedValue(new BadRequestException('Your store credit balance changed'));
    const { service } = makeService(null, { assertCovers });
    await expect(service.assertStoreCreditStillCovers(applied)).rejects.toThrow(/balance changed/);
  });

  it('storeCreditPayment refuses a checkout without applied credit', async () => {
    const { service } = makeService({ _id: 'c1', status: 'pending', items: [], totalAmount: 0, storeCreditApplied: false });
    await expect(service.storeCreditPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(/Apply your store credit first/);
  });

  it('storeCreditPayment refuses when the credit does not cover the whole total', async () => {
    const { service } = makeService({ _id: 'c1', status: 'pending', items: [], totalAmount: 4.99, ...applied });
    await expect(service.storeCreditPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(/does not cover the full amount/);
  });

  it('storeCreditPayment refuses completed, cancelled and expired checkouts', async () => {
    for (const status of ['completed', 'cancelled', 'expired']) {
      const { service } = makeService({ _id: 'c1', status, items: [], totalAmount: 0, ...applied });
      await expect(service.storeCreditPayment('u1', { checkoutId: 'c1' })).rejects.toThrow(BadRequestException);
    }
  });

  it('storeCreditPayment requires a checkoutId', async () => {
    const { service } = makeService(null);
    await expect(service.storeCreditPayment('u1', {})).rejects.toThrow(/checkoutId is required/);
  });
});
