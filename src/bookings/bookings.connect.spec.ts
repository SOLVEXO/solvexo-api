/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { BookingsService } from './bookings.service';

const STORE = 'store-1';
const PKG = { _id: 'pkg-1', storeId: STORE, sellerId: 'seller-1', serviceId: 'svc-1', name: 'Pack of 5', price: 100, sessionsCount: 5, validityDays: 30, currency: 'USD' };

function setup(opts: { connect?: string | null; providerDriven?: boolean; chargeOk?: boolean } = {}) {
  const connect = opts.connect === undefined ? 'acct_seller' : opts.connect;
  const purchaseModel = {
    create: jest.fn().mockImplementation(async (d: any) => ({ _id: 'purchase-1', ...d, save: jest.fn().mockResolvedValue(undefined) })),
    deleteOne: jest.fn().mockResolvedValue({}),
  };
  const db = {
    repositories: {
      servicePackageModel: { findOne: jest.fn().mockResolvedValue(PKG) },
      bookableServiceModel: { findById: jest.fn().mockResolvedValue({ _id: 'svc-1', isDelete: false }) },
      packagePurchaseModel: purchaseModel,
      userModel: { findById: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_1', email: 'b@x.com', save: jest.fn() }) },
      storeModel: { findById: jest.fn() },
    },
  } as any;
  const gateway = {
    isProviderDrivenBilling: opts.providerDriven ?? true,
    providerName: 'stripe',
    chargeOneTime: jest.fn().mockResolvedValue(opts.chargeOk === false ? { success: false, providerChargeId: '', failureReason: 'declined' } : { success: true, providerChargeId: 'pi_1' }),
  };
  const finance = { recordBookingRevenue: jest.fn().mockResolvedValue(undefined) };
  const stripeConnect = { getEligibleConnectAccountForStore: jest.fn().mockResolvedValue(connect) };
  const commission = { cardApplicationFeeCents: jest.fn().mockResolvedValue(320) };
  const service = new BookingsService(db, gateway as any, finance as any, { notify: jest.fn().mockResolvedValue(undefined) } as any, stripeConnect as any, commission as any);
  jest.spyOn(service as any, 'ensureProviderCustomerId').mockResolvedValue('cus_1');
  return { service, gateway, finance, purchaseModel, commission };
}

describe('BookingsService.purchasePackage — paid sessions go straight to the seller', () => {
  it('charges as a destination charge to the seller\'s connected account and does NOT credit the platform ledger', async () => {
    const { service, gateway, finance, commission } = setup();

    await service.purchasePackage('buyer-1', 'pkg-1', 'idem-1');

    expect(commission.cardApplicationFeeCents).toHaveBeenCalledWith(STORE, 10000);
    expect(gateway.chargeOneTime).toHaveBeenCalledWith(
      'purchase-1', 100,
      expect.objectContaining({ connectAccountId: 'acct_seller', applicationFeeAmountCents: 320, providerCustomerId: 'cus_1' }),
    );
    expect(finance.recordBookingRevenue).not.toHaveBeenCalled(); // already in the seller's own account — no double credit
  });

  it('REGRESSION: a store with no connected card provider cannot sell packages — nothing is created or charged', async () => {
    const { service, gateway, purchaseModel } = setup({ connect: null });

    await expect(service.purchasePackage('buyer-1', 'pkg-1', 'idem-2')).rejects.toBeInstanceOf(BadRequestException);

    expect(purchaseModel.create).not.toHaveBeenCalled();
    expect(gateway.chargeOneTime).not.toHaveBeenCalled();
  });

  it('keeps the legacy ledger credit only for the non-Stripe dev gateway (nothing is Connect-routed there)', async () => {
    const { service, gateway, finance } = setup({ providerDriven: false });

    await service.purchasePackage('buyer-1', 'pkg-1', 'idem-3');

    expect(gateway.chargeOneTime).toHaveBeenCalledWith('purchase-1', 100, expect.not.objectContaining({ connectAccountId: expect.anything() }));
    expect(finance.recordBookingRevenue).toHaveBeenCalledTimes(1);
  });

  it('a declined charge deletes the pending purchase and never credits anything', async () => {
    const { service, finance, purchaseModel } = setup({ chargeOk: false });

    await expect(service.purchasePackage('buyer-1', 'pkg-1', 'idem-4')).rejects.toThrow(/Payment failed/);

    expect(purchaseModel.deleteOne).toHaveBeenCalled();
    expect(finance.recordBookingRevenue).not.toHaveBeenCalled();
  });
});
