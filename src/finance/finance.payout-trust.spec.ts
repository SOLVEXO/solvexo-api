/* eslint-disable prettier/prettier */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { SellerTrustService } from '../seller-trust/seller-trust.service';
import { PAYOUT_HOLD_MESSAGE } from '../seller-trust/seller-trust-deadline.util';

// Payouts are refused (manual) / skipped (scheduled) only while a store is
// trust-limited (unverified after its deadline) or on a manual admin hold.

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';
const DAY = 86_400_000;

function build(store: any, settings: any) {
  const storeDoc = { _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, status: 'active', ...store };
  const storeModel = {
    findById: jest.fn().mockImplementation(() => Object.assign(Promise.resolve(storeDoc), {
      select: () => ({ lean: () => Promise.resolve(storeDoc) }),
    })),
  };
  const methodModel = { findById: jest.fn().mockResolvedValue(null), find: jest.fn(), findOne: jest.fn(), exists: jest.fn().mockResolvedValue(true) };
  const scheduleModel = {
    find: jest.fn().mockReturnValue({ lean: () => Promise.resolve([{ _id: 'sch-1', storeId: STORE_ID, sellerId: SELLER_ID, frequency: 'weekly', dayOfWeek: 1, isEnabled: true, currency: 'USD', defaultPayoutMethodId: 'm-1' }]) }),
    updateOne: jest.fn().mockResolvedValue({}),
    findOne: jest.fn(),
  };
  const sellerModel = { findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ status: 'active', isDelete: false }) }) }) };
  const db: any = { repositories: { storeModel, methodModel, payoutMethodModel: methodModel, payoutScheduleModel: scheduleModel, sellerModel, payoutModel: { exists: jest.fn() }, sellerBalanceModel: { findOne: jest.fn() } } };
  const adminConfig: any = { getSellerTrustSettings: jest.fn().mockResolvedValue(settings), getPayoutMinimum: jest.fn().mockResolvedValue(5) };
  const sellerTrust = new SellerTrustService(db, adminConfig);
  const stripeConnect: any = { getPayoutEligibility: jest.fn().mockResolvedValue(null) };
  const service = new FinanceService(db, { log: jest.fn() } as any, {} as any, adminConfig, { notify: jest.fn(), notifyAdmins: jest.fn() } as any, stripeConnect, { transaction: jest.fn() } as any, sellerTrust);
  return { service, methodModel, stripeConnect };
}

const started = { enforcementStartedAt: new Date(Date.now() - 40 * DAY), graceDays: 30 };
const notStarted = { enforcementStartedAt: null, graceDays: 30 };
const oldStore = { createdAt: new Date(Date.now() - 400 * DAY) };

describe('FinanceService payouts — seller trust gate', () => {
  it('refuses a manual payout for an unverified store past its deadline', async () => {
    const { service, methodModel } = build({ ...oldStore, verificationStatus: 'pending' }, started);
    await expect(service.requestPayout(SELLER_ID, STORE_ID, { payoutMethodId: 'm-1', amount: 50 } as any)).rejects.toThrow(PAYOUT_HOLD_MESSAGE);
    expect(methodModel.findById).not.toHaveBeenCalled();
  });

  it('refuses a manual payout while an admin hold is on (even when verified)', async () => {
    const { service } = build({ ...oldStore, verificationStatus: 'verified', payoutHold: { active: true, reason: 'chargebacks' } }, notStarted);
    await expect(service.requestPayout(SELLER_ID, STORE_ID, { payoutMethodId: 'm-1', amount: 50 } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets the payout through when not limited (before the deadline / enforcement off / verified)', async () => {
    for (const [store, settings] of [
      [{ ...oldStore, verificationStatus: 'pending' }, notStarted],
      [{ ...oldStore, verificationStatus: 'pending' }, { enforcementStartedAt: new Date(Date.now() - 2 * DAY), graceDays: 30 }],
      [{ ...oldStore, verificationStatus: 'verified' }, started],
    ] as const) {
      const { service, methodModel } = build(store, settings);
      // Gets past the trust gate and fails later on the (unmocked) payout method — proving the gate allowed it.
      await expect(service.requestPayout(SELLER_ID, STORE_ID, { payoutMethodId: 'm-1', amount: 50 } as any)).rejects.toBeInstanceOf(NotFoundException);
      expect(methodModel.findById).toHaveBeenCalled();
    }
  });

  it('scheduled payouts skip a limited store without touching its balance', async () => {
    const { service, methodModel, stripeConnect } = build({ ...oldStore, verificationStatus: 'not_started' }, started);
    jest.spyOn(service as any, 'computeNextPayoutDate').mockReturnValue(new Date());
    const result = await service.processScheduledPayouts();
    expect(result).toMatchObject({ schedulesChecked: 1, payoutsCreated: 0, skipped: 1 });
    expect(methodModel.findById).not.toHaveBeenCalled();
    expect(stripeConnect.getPayoutEligibility).not.toHaveBeenCalled();
  });

  it('scheduled payouts skip a store on a manual hold', async () => {
    const { service, methodModel } = build({ ...oldStore, verificationStatus: 'verified', payoutHold: { active: true } }, notStarted);
    jest.spyOn(service as any, 'computeNextPayoutDate').mockReturnValue(new Date());
    const result = await service.processScheduledPayouts();
    expect(result.skipped).toBe(1);
    expect(methodModel.findById).not.toHaveBeenCalled();
  });
});
