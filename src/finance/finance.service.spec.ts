/* eslint-disable prettier/prettier */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { DatabaseService } from '../database/databaseservice';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { CommissionRulesService } from '../commission-rules/commission-rules.service';
import { AdminConfigService } from '../admin-config/admin-config.service';

const STORE_ID = 'store-1';
const SELLER_ID = 'seller-1';

/** A chainable `.find()` result stub — `.sort()/.skip()/.limit()/.select()` all
 * return the same chain object (any order, any subset), `.lean()` resolves to
 * `result`, matching every call shape used across finance.service.ts. */
function makeChainableFind(result: any[] = []) {
  const chain: any = {};
  chain.sort = jest.fn().mockReturnValue(chain);
  chain.skip = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockReturnValue(chain);
  chain.select = jest.fn().mockReturnValue(chain);
  chain.lean = jest.fn().mockResolvedValue(result);
  return chain;
}

/** A minimal Mongoose-Model-like constructor mock: `new Model(doc)` returns an
 * object carrying the doc's fields plus a `.save()` that resolves to itself —
 * enough to exercise FinanceService's `new this.txModel(...); await tx.save()`
 * pattern without needing a real Mongo connection. */
function makeConstructableModelMock() {
  const created: any[] = [];
  let counter = 0;
  const Model: any = jest.fn().mockImplementation((doc: any) => {
    const instance = { _id: `mock-id-${++counter}`, ...doc, save: jest.fn().mockImplementation(async function (this: any) { return this; }) };
    created.push(instance);
    return instance;
  });
  Model.created = created;
  Model.findOne = jest.fn();
  Model.findById = jest.fn();
  // recordSale's idempotency probe: `txModel.exists({...}).session(session)` — default "no prior sale".
  Model.exists = jest.fn().mockImplementation(() => ({ session: () => Promise.resolve(null) }));
  Model.find = jest.fn().mockReturnValue(makeChainableFind([]));
  Model.updateOne = jest.fn().mockResolvedValue({});
  Model.countDocuments = jest.fn().mockResolvedValue(0);
  Model.aggregate = jest.fn().mockResolvedValue([]);
  return Model;
}

function makeBalance(overrides: Partial<Record<string, any>> = {}) {
  return {
    storeId: STORE_ID, sellerId: SELLER_ID, currency: 'USD',
    availableBalance: 0, pendingBalance: 0,
    totalRevenue: 0, totalFees: 0, totalRefunds: 0, totalPayouts: 0,
    isFlaggedForReview: false, flaggedReason: null, flaggedAt: null,
    save: jest.fn().mockImplementation(async function (this: any) { return this; }),
    ...overrides,
  };
}

describe('FinanceService', () => {
  let service: FinanceService;
  let balanceModel: any;
  let txModel: any;
  let payoutModel: any;
  let methodModel: any;
  let scheduleModel: any;
  let storeModel: any;
  let sellerModel: any;
  let connection: any;
  let activityLogService: ActivityLogService;
  let commissionRulesService: CommissionRulesService;
  let adminConfigService: AdminConfigService;
  let notificationsService: any;
  let stripeConnectService: any;

  let orderModel: any;

  beforeEach(() => {
    balanceModel = { findOne: jest.fn(), find: jest.fn().mockReturnValue(makeChainableFind([])) };
    txModel = makeConstructableModelMock();
    payoutModel = makeConstructableModelMock();
    payoutModel.exists = jest.fn().mockResolvedValue(false);
    // Conditional status claim (claimPayoutStatus) — resolves "won the race" unless a test overrides it.
    payoutModel.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    methodModel = {
      findById: jest.fn(), findOne: jest.fn(), find: jest.fn().mockReturnValue(makeChainableFind([])),
      exists: jest.fn().mockResolvedValue(true), updateMany: jest.fn(),
      create: jest.fn().mockImplementation(async (doc: any) => ({ _id: 'auto-method-1', save: jest.fn(), ...doc })),
    };
    scheduleModel = { findOne: jest.fn(), find: jest.fn().mockReturnValue(makeChainableFind([])), updateOne: jest.fn().mockResolvedValue({}) };
    // `findById` is awaited directly (ownership checks) AND chained `.select().lean()` (scheduled-payout status checks).
    const activeStore = { _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, status: 'active' };
    storeModel = {
      findById: jest.fn().mockImplementation(() => Object.assign(Promise.resolve(activeStore), {
        select: () => ({ lean: () => Promise.resolve(activeStore) }),
      })),
    };
    sellerModel = { findById: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Jane Seller' }) }) }) };
    orderModel = { find: jest.fn().mockReturnValue(makeChainableFind([])) };

    const db = {
      repositories: {
        sellerBalanceModel: balanceModel, transactionModel: txModel, payoutModel,
        payoutMethodModel: methodModel, payoutScheduleModel: scheduleModel,
        storeModel, sellerModel, taxReportModel: {}, campaignModel: { findByIdAndUpdate: jest.fn() },
        orderModel,
        // latest FX rate lookup (fixed card-fee text) — "no rate" by default
        exchangeRateModel: { findOne: jest.fn().mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) }) },
      },
    } as unknown as DatabaseService;

    activityLogService = { log: jest.fn() } as any;
    commissionRulesService = { resolveRate: jest.fn().mockResolvedValue({ rate: 0.08, source: 'hardcoded_fallback' }) } as any;
    adminConfigService = { getPayoutMinimum: jest.fn().mockResolvedValue(5) } as any;
    notificationsService = { notify: jest.fn().mockResolvedValue(undefined) };
    // Stubbed as "seller has no Connect account" by default — the payout
    // automation tests that DO care about the Connect rail override
    // `getPayoutEligibility`/`createTransfer` per-test.
    stripeConnectService = {
      getPayoutEligibility: jest.fn().mockResolvedValue(null),
      createTransfer: jest.fn(),
      reverseTransfer: jest.fn(),
    };

    // `connection.transaction(fn)` just runs fn with a stand-in session —
    // no real Mongo transaction semantics needed to unit-test the ledger math.
    connection = { transaction: jest.fn().mockImplementation(async (fn: any) => fn({})) };

    service = new FinanceService(db, activityLogService, commissionRulesService, adminConfigService, notificationsService, stripeConnectService, connection);
  });

  describe('recordSale', () => {
    it('splits a sale into net seller credit (pending) and a platform+processing fee entry, using the resolved commission rate', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      // saleAmount=100, platformFee=5 (5%), processingFee=100*0.029+0.30=3.20, netAmount=91.80
      await service.recordSale(STORE_ID, SELLER_ID, 'order-1', 100, 'Sale — Order #order-1');

      expect(balance.pendingBalance).toBeCloseTo(91.80, 2);
      expect(balance.totalRevenue).toBe(100);
      expect(balance.totalFees).toBeCloseTo(8.20, 2);

      const saleTx = txModel.created.find((t: any) => t.type === 'sale');
      const feeTx = txModel.created.find((t: any) => t.type === 'fee');
      expect(saleTx.amount).toBe(100);
      expect(saleTx.metadata.feeRateSource).toBe('seller_override');
      expect(feeTx.amount).toBeCloseTo(-8.20, 2);
    });

    it('pays down a prior negative (debt) balance and clears the review flag once both balances are non-negative again', async () => {
      const balance = makeBalance({ pendingBalance: -20, isFlaggedForReview: true, flaggedReason: 'prior debt' });
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0, source: 'seller_override' });

      // saleAmount=100, 0% commission, processingFee=3.20 → net=96.80 credited to pendingBalance (-20 + 96.80 = 76.80 >= 0)
      await service.recordSale(STORE_ID, SELLER_ID, 'order-2', 100, 'desc');

      expect(balance.pendingBalance).toBeCloseTo(76.80, 2);
      expect(balance.isFlaggedForReview).toBe(false);
      expect(balance.flaggedReason).toBeNull();
    });

    it('COD sale: the platform never held the cash, so NOTHING is credited — an (override) commission only ACCRUES for the monthly bill, no card fee', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      // saleAmount=100, platformFee=5 (5% override), processingFee=0 → seller owes 5 (billed later), receives no balance credit
      await service.recordSale(STORE_ID, SELLER_ID, 'order-cod', 100, 'desc', 0, null, 'USD', 'cash_on_delivery');

      expect(balance.pendingBalance).toBe(0);
      expect(balance.availableBalance).toBe(0); // the fee is NOT taken out of a sales balance (Shopify bills it on the plan invoice)
      expect(balance.totalRevenue).toBe(100);
      expect(balance.totalFees).toBe(5);
      const saleTx = txModel.created.find((t: any) => t.referenceId === 'order-cod' && t.type === 'sale');
      expect(saleTx.status).toBe('completed'); // informational: nothing for the clearing cron to release
      expect(saleTx.metadata.settledDirectly).toBe(true);
      expect(saleTx.metadata.netAmount).toBe(0);
      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-cod' && t.type === 'fee');
      expect(feeTx.amount).toBe(-5);
      expect(feeTx.metadata.processingFee).toBe(0);
      expect(feeTx.metadata.billing).toEqual({ status: 'pending_invoice' }); // waits for TransactionFeeBillingService
    });

    // Shopify-style fee model: the plan's transaction fee is a THIRD-PARTY gateway fee only.
    it('charges no commission and no card fee on a manual bank-transfer sale under a plan rate', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.02, source: 'platform_plan' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-mbt', 27800, 'desc', 0, null, 'PKR', 'manual_bank_transfer');

      // fee-free AND not credited: the buyer paid the seller directly, the platform holds nothing
      expect(balance.pendingBalance).toBe(0);
      expect(balance.availableBalance).toBe(0);
      expect(balance.totalFees).toBe(0);
      expect(balance.totalRevenue).toBe(27800);
      const mbtFee = txModel.created.find((t: any) => t.referenceId === 'order-mbt' && t.type === 'fee');
      expect(mbtFee.metadata.billing).toBeUndefined(); // zero fee → nothing to bill
    });

    it('charges the plan\'s third-party gateway fee on a SafePay sale (and no card-network fee)', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.02, source: 'platform_plan' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-safepay', 27800, 'desc', 0, null, 'PKR', 'safepay');

      expect(balance.totalFees).toBeCloseTo(556, 2); // 2% of 27800 — the third-party fee
      // The seller's OWN Safepay account already received the money: no second credit,
      // and the plan's third-party fee accrues for the monthly platform bill — it is NOT debited from a balance.
      expect(balance.pendingBalance).toBe(0);
      expect(balance.availableBalance).toBe(0);
      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-safepay' && t.type === 'fee');
      expect(feeTx.amount).toBeCloseTo(-556, 2);
      expect(feeTx.metadata.billing).toEqual({ status: 'pending_invoice' });
    });

    it('charges only the card-processing cost (no plan commission) on a Stripe sale through Solvexo Payments', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.02, source: 'platform_plan' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-card', 100, 'desc', 0, null, 'USD', 'stripe');

      expect(balance.totalFees).toBeCloseTo(3.20, 2); // 2.9% + $0.30, nothing on top
      expect(balance.pendingBalance).toBeCloseTo(96.80, 2);
    });

    it('still charges the card-processing fee for a Stripe sale', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-stripe', 100, 'desc', 0, null, 'USD', 'stripe');

      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-stripe' && t.type === 'fee');
      expect(feeTx.amount).toBeCloseTo(-8.20, 2); // 5 (platform) + 3.20 (processing)
    });
  });

  describe('recordSale — idempotency and direct-settled rails', () => {
    it('REGRESSION: a second recordSale for the same order is a no-op (no double credit)', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      txModel.exists.mockImplementation(() => ({ session: () => Promise.resolve({ _id: 'existing-sale' }) }));

      await service.recordSale(STORE_ID, SELLER_ID, 'order-dup', 100, 'desc', 0, null, 'USD', 'stripe');

      expect(balance.pendingBalance).toBe(0);
      expect(balance.totalRevenue).toBe(0);
      expect(txModel.created).toHaveLength(0);
      expect(txModel.exists).toHaveBeenCalledWith(expect.objectContaining({ storeId: STORE_ID, referenceId: 'order-dup', type: 'sale' }));
    });

    it('a platform-held Stripe sale\'s fee is netted from the credit (never queued for the monthly bill)', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-net', 100, 'desc', 0, null, 'USD', 'stripe');

      const feeTx = txModel.created.find((t: any) => t.referenceId === 'order-net' && t.type === 'fee');
      expect(feeTx.metadata.billing).toBeUndefined();
    });

    it('a Stripe (platform-held) sale is still credited to pending and stays "pending" for the clearing cron', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.02, source: 'platform_plan' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-card2', 100, 'desc', 0, null, 'USD', 'stripe');

      const saleTx = txModel.created.find((t: any) => t.type === 'sale');
      expect(saleTx.status).toBe('pending');
      expect(saleTx.metadata.settledDirectly).toBe(false);
      expect(balance.availableBalance).toBe(0);
    });

    it('on a direct-settled rail the platform-sponsored discount (which the platform really owes the seller) is still credited', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.02, source: 'platform_plan' });

      // COD: no fee (manual rail), sponsored 7 → only the 7 is credited
      await service.recordSale(STORE_ID, SELLER_ID, 'order-sponsored', 100, 'desc', 7, 'camp-1', 'USD', 'cash_on_delivery');

      expect(balance.pendingBalance).toBe(7);
      expect(balance.availableBalance).toBe(0);
      const saleTx = txModel.created.find((t: any) => t.type === 'sale');
      expect(saleTx.status).toBe('pending');
      expect(saleTx.metadata.netAmount).toBe(7);
    });
  });

  describe('recordSale — Stripe Connect settled (money already in the seller\'s own Stripe account)', () => {
    it('records the sale for revenue/reports but credits nothing, bills no fee and writes no fee row', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);
      // even a custom per-seller rate must not be billed again: it was already taken as the charge's application_fee
      commissionRulesService.resolveRate = jest.fn().mockResolvedValue({ rate: 0.05, source: 'seller_override' });

      await service.recordSale(STORE_ID, SELLER_ID, 'order-connect', 5000, 'desc', 0, null, 'PKR', 'stripe', true);

      expect(balance.pendingBalance).toBe(0);
      expect(balance.availableBalance).toBe(0);
      expect(balance.totalRevenue).toBe(5000);
      expect(balance.totalFees).toBe(0);
      const saleTx = txModel.created.find((t: any) => t.type === 'sale');
      expect(saleTx).toMatchObject({ amount: 5000, currency: 'PKR', status: 'completed' });
      expect(saleTx.metadata).toMatchObject({ settledDirectly: true, settledViaConnect: true, platformFee: 0, processingFee: 0 });
      expect(txModel.created.find((t: any) => t.type === 'fee')).toBeUndefined();
    });

    it('a later refund of a Connect sale claws back nothing from the ledger (Stripe refunds the buyer from the seller\'s account)', async () => {
      const balance = makeBalance({ availableBalance: 40 });
      balanceModel.findOne.mockResolvedValue(balance);
      txModel.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue({ amount: 100, metadata: { settledDirectly: true, settledViaConnect: true } }) });

      const res: any = await service.recordRefund(STORE_ID, SELLER_ID, 'order-connect', 100);

      expect(res.skipped).toBe('settled_directly');
      expect(balance.availableBalance).toBe(40);
    });

    it('still credits a platform-sponsored discount the platform owes the seller', async () => {
      const balance = makeBalance();
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordSale(STORE_ID, SELLER_ID, 'order-connect-sp', 100, 'desc', 7, 'camp-1', 'USD', 'stripe', true);

      expect(balance.pendingBalance).toBe(7);
    });
  });

  describe('recordRefund', () => {
    /** An order refund only claws back money the seller was actually credited — give it a sale to find. */
    const givenSale = (amount = 1000, metadata: any = { settledDirectly: false }) => {
      txModel.findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve({ amount, metadata }) });
    };
    beforeEach(() => givenSale());

    it('deducts fully from availableBalance when it covers the refund', async () => {
      const balance = makeBalance({ availableBalance: 100, pendingBalance: 0 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-3', 40);

      expect(balance.availableBalance).toBe(60);
      expect(balance.pendingBalance).toBe(0);
      expect(balance.isFlaggedForReview).toBe(false);
    });

    it('spills into pendingBalance once availableBalance is exhausted', async () => {
      const balance = makeBalance({ availableBalance: 10, pendingBalance: 50 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-4', 30);

      expect(balance.availableBalance).toBe(0);
      expect(balance.pendingBalance).toBe(30); // 50 - (30 - 10)
      expect(balance.isFlaggedForReview).toBe(false);
    });

    it('drives the balance negative and flags the seller for admin review when the refund exceeds everything held (seller already withdrew it) — does not silently ignore the overflow', async () => {
      const balance = makeBalance({ availableBalance: 5, pendingBalance: 10 });
      balanceModel.findOne.mockResolvedValue(balance);

      const result = await service.recordRefund(STORE_ID, SELLER_ID, 'order-5', 50);

      expect(balance.availableBalance).toBe(0);
      expect(balance.pendingBalance).toBe(-35); // 10 - (50 - 5)
      expect(balance.isFlaggedForReview).toBe(true);
      expect(balance.flaggedReason).toContain('exceeded');
      expect(result.balanceAfter).toBe(0);

      // Admin-visible security alert fired exactly once for the negative flip.
      expect(activityLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'seller_balance_negative', isSecurityAlert: true }),
      );
    });

    it('does not re-fire the negative-balance alert on a second refund while already flagged', async () => {
      const balance = makeBalance({ availableBalance: 0, pendingBalance: -35, isFlaggedForReview: true, flaggedReason: 'already flagged' });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-6', 10);

      expect(balance.pendingBalance).toBe(-45);
      expect(activityLogService.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'seller_balance_negative' }),
      );
    });

    it('REGRESSION: an order whose sale was never credited (e.g. cancelled before completion / Connect-settled) debits NOTHING and never flags the seller', async () => {
      const balance = makeBalance({ availableBalance: 0, pendingBalance: 0 });
      balanceModel.findOne.mockResolvedValue(balance);
      txModel.findOne = jest.fn().mockReturnValue({ lean: () => Promise.resolve(null) }); // no sale tx

      const result: any = await service.recordRefund(STORE_ID, SELLER_ID, 'order-uncredited', 40);

      expect(result.skipped).toBe('no_sale_credited');
      expect(balance.availableBalance).toBe(0);
      expect(balance.pendingBalance).toBe(0);
      expect(balance.isFlaggedForReview).toBe(false);
      expect(txModel.created.filter((t: any) => t.type === 'refund')).toHaveLength(0);
    });

    it('REGRESSION: a refund on a direct-settled (COD / seller-gateway) sale never touches the platform balance', async () => {
      const balance = makeBalance({ availableBalance: 80, pendingBalance: 0 });
      balanceModel.findOne.mockResolvedValue(balance);
      givenSale(100, { settledDirectly: true });

      const result: any = await service.recordRefund(STORE_ID, SELLER_ID, 'order-cod-refund', 100);

      expect(result.skipped).toBe('settled_directly');
      expect(balance.availableBalance).toBe(80);
    });

    it('caps the refund at what was credited for the order (e.g. shipping was never credited) — never claws back more', async () => {
      const balance = makeBalance({ availableBalance: 500 });
      balanceModel.findOne.mockResolvedValue(balance);
      givenSale(100); // seller was credited 100 for this order

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-capped', 120); // 100 items + 20 shipping

      expect(balance.availableBalance).toBe(400); // only 100 clawed back
      expect(txModel.created.find((t: any) => t.type === 'refund').amount).toBe(-100);
    });

    it('caps cumulative refunds: a second refund only claws back the remainder, and a third is skipped', async () => {
      const balance = makeBalance({ availableBalance: 500 });
      balanceModel.findOne.mockResolvedValue(balance);
      givenSale(100);
      txModel.find = jest.fn().mockReturnValue(makeChainableFind([{ amount: -70 }])); // 70 already refunded

      await service.recordRefund(STORE_ID, SELLER_ID, 'order-partial', 50);
      expect(balance.availableBalance).toBe(470); // 100 - 70 = 30 remaining

      txModel.find = jest.fn().mockReturnValue(makeChainableFind([{ amount: -100 }]));
      const result: any = await service.recordRefund(STORE_ID, SELLER_ID, 'order-partial', 10);
      expect(result.skipped).toBe('already_fully_refunded');
      expect(balance.availableBalance).toBe(470);
    });

    it('non-order references (subscription / plan invoices) skip the order-sale guard entirely', async () => {
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);
      txModel.findOne = jest.fn(); // would throw if consulted

      await service.recordRefund(STORE_ID, SELLER_ID, 'inv-1', 30, undefined, undefined, { referenceType: 'subscription_invoice' });

      expect(balance.availableBalance).toBe(70);
      expect(txModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe('requestPayout', () => {
    it('rejects a payout method that is not active yet', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'pending_verification', currency: 'USD' });

      await expect(
        service.requestPayout(SELLER_ID, STORE_ID, { amount: 10, payoutMethodId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an amount below the configured per-currency minimum', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'PKR', type: 'jazzcash' });
      adminConfigService.getPayoutMinimum = jest.fn().mockResolvedValue(1500);

      await expect(
        service.requestPayout(SELLER_ID, STORE_ID, { amount: 500, payoutMethodId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(adminConfigService.getPayoutMinimum).toHaveBeenCalledWith('PKR');
    });

    it('rejects a withdrawal larger than the available balance', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'USD', type: 'bank_transfer' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 20 }));

      await expect(
        service.requestPayout(SELLER_ID, STORE_ID, { amount: 50, payoutMethodId: 'm1' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('debits the available balance and creates a processing payout + ledger entry on success', async () => {
      methodModel.findById.mockResolvedValue({ _id: 'm1', storeId: STORE_ID, status: 'active', currency: 'USD', type: 'bank_transfer', bankName: 'Chase', accountLast4: '1234' });
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);

      const payout = await service.requestPayout(SELLER_ID, STORE_ID, { amount: 40, payoutMethodId: 'm1' } as any);

      expect(balance.availableBalance).toBe(60);
      expect(balance.totalPayouts).toBe(40);
      expect(payout.status).toBe('processing');
      expect(txModel.created.find((t: any) => t.type === 'payout').amount).toBe(-40);
    });
  });

  describe('adminRejectPayout', () => {
    it('reverses the deduction back onto the available balance and marks the payout failed', async () => {
      const payout = { _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD', status: 'processing', save: jest.fn() };
      payoutModel.findById = jest.fn().mockResolvedValue(payout);
      const balance = makeBalance({ availableBalance: 60, totalPayouts: 40 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.adminRejectPayout('p1', 'admin-1', 'bank details invalid');

      expect(balance.availableBalance).toBe(100);
      expect(balance.totalPayouts).toBe(0);
      expect(payout.status).toBe('failed');
    });

    it('throws when the payout is not pending/processing', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue({ status: 'completed' });
      await expect(service.adminRejectPayout('p1', 'admin-1', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for a missing payout', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue(null);
      await expect(service.adminRejectPayout('missing', 'admin-1', 'reason')).rejects.toThrow(NotFoundException);
    });

    it('a lost race (payout already moved by a concurrent request) gives 409 and credits nothing', async () => {
      const payout = { _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD', status: 'processing', save: jest.fn() };
      payoutModel.findById = jest.fn().mockResolvedValue(payout);
      payoutModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const balance = makeBalance({ availableBalance: 60, totalPayouts: 40 });
      balanceModel.findOne.mockResolvedValue(balance);

      await expect(service.adminRejectPayout('p1', 'admin-1', 'reason')).rejects.toThrow(ConflictException);

      expect(balance.availableBalance).toBe(60);
      expect(balance.save).not.toHaveBeenCalled();
    });
  });

  describe('adminApprovePayout — concurrency', () => {
    it('claims pending/processing → completed with a conditional update', async () => {
      const payout = { _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD', railType: 'manual', status: 'processing' };
      payoutModel.findById = jest.fn().mockResolvedValue(payout);

      await service.adminApprovePayout('p1', 'admin-1');

      expect(payoutModel.updateOne).toHaveBeenCalledWith(
        { _id: 'p1', status: { $in: ['pending', 'processing'] } },
        { $set: expect.objectContaining({ status: 'completed' }) },
        expect.anything(),
      );
      expect(payout.status).toBe('completed');
    });

    it('a concurrent reject that already won gives 409 instead of overwriting it with completed', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue({ _id: 'p1', railType: 'manual', status: 'processing', amount: 40 });
      payoutModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      await expect(service.adminApprovePayout('p1', 'admin-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('adminRetryFailedPayout — concurrency', () => {
    const failedPayout = () => ({
      _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD',
      railType: 'manual', status: 'failed', payoutMethodSnapshot: { type: 'bank' },
    });

    it('debits the balance only after winning the failed → processing claim', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue(failedPayout());
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);

      await service.adminRetryFailedPayout('p1', 'admin-1');

      expect(payoutModel.updateOne).toHaveBeenCalledWith(
        { _id: 'p1', status: { $in: ['failed'] } },
        { $set: expect.objectContaining({ status: 'processing' }) },
        expect.anything(),
      );
      expect(balance.availableBalance).toBe(60);
    });

    it('a second simultaneous retry loses the claim: 409 and no second debit', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue(failedPayout());
      payoutModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);

      await expect(service.adminRetryFailedPayout('p1', 'admin-1')).rejects.toThrow(ConflictException);

      expect(balance.availableBalance).toBe(100);
      expect(balance.save).not.toHaveBeenCalled();
    });
  });

  describe('processScheduledPayouts', () => {
    function makeSchedule(overrides: Partial<Record<string, any>> = {}) {
      return {
        _id: 'sched-1', storeId: STORE_ID, sellerId: SELLER_ID, currency: 'USD',
        frequency: 'weekly', dayOfWeek: 1, dayOfMonth: 1, minimumAmount: 50,
        isEnabled: true, defaultPayoutMethodId: 'm1', nextPayoutAt: new Date(Date.now() - 1000),
        ...overrides,
      };
    }

    it('advances nextPayoutAt and skips a schedule with no default payout method', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule({ defaultPayoutMethodId: null })]) });

      const result = await service.processScheduledPayouts();

      expect(scheduleModel.updateOne).toHaveBeenCalledWith({ _id: 'sched-1' }, { $set: { nextPayoutAt: expect.any(Date) } });
      expect(result).toEqual({ schedulesChecked: 1, payoutsCreated: 0, totalAmount: 0, skipped: 1 });
    });

    it('skips when the default payout method is missing or not active', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule()]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'pending_verification' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 200 }));

      const result = await service.processScheduledPayouts();
      expect(result.payoutsCreated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('skips a store that already has a payout in flight, to avoid stacking requests', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule()]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'active', type: 'bank_transfer', currency: 'USD' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 200 }));
      payoutModel.exists.mockResolvedValue(true);

      const result = await service.processScheduledPayouts();
      expect(result.payoutsCreated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('skips when available balance is below the greater of the schedule minimum and the platform floor', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule({ minimumAmount: 100 })]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'active', type: 'bank_transfer', currency: 'USD' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 80 }));

      const result = await service.processScheduledPayouts();
      expect(result.payoutsCreated).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it('sweeps the full available balance into a scheduled_auto payout and notifies the seller', async () => {
      scheduleModel.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([makeSchedule({ minimumAmount: 50 })]) });
      methodModel.findById.mockResolvedValue({ _id: 'm1', status: 'active', type: 'bank_transfer', bankName: 'Chase', currency: 'USD' });
      const balance = makeBalance({ availableBalance: 200 });
      balanceModel.findOne.mockResolvedValue(balance);

      const result = await service.processScheduledPayouts();

      expect(result).toEqual({ schedulesChecked: 1, payoutsCreated: 1, totalAmount: 200, skipped: 0 });
      expect(balance.availableBalance).toBe(0);
      const payout = payoutModel.created.find((p: any) => p.source === 'scheduled_auto');
      expect(payout.amount).toBe(200);
      expect(notificationsService.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'payout_auto_initiated', recipientId: SELLER_ID }));
    });

    it("keeps processing the remaining schedules when one schedule's lookup throws", async () => {
      scheduleModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([makeSchedule({ _id: 'sched-bad', storeId: 'store-bad' }), makeSchedule({ _id: 'sched-2', storeId: 'store-2' })]),
      });
      methodModel.findById = jest.fn()
        .mockRejectedValueOnce(new Error('db blip'))
        .mockResolvedValueOnce({ _id: 'm1', status: 'active', type: 'bank_transfer', currency: 'USD' });
      balanceModel.findOne.mockResolvedValue(makeBalance({ availableBalance: 200 }));

      const result = await service.processScheduledPayouts();
      expect(result.schedulesChecked).toBe(2);
      expect(result.payoutsCreated).toBe(1);
      expect(result.skipped).toBe(1);
    });
  });

  describe('Stripe Connect automated payouts', () => {
    it('ensureStripeConnectPayoutMethod creates an active auto-managed method when the seller has a fully-onboarded Connect account', async () => {
      stripeConnectService.getPayoutEligibility.mockResolvedValue({ accountId: 'acct_123', eligible: true, status: 'active' });
      methodModel.findOne.mockResolvedValue(null); // no existing row yet
      methodModel.exists.mockResolvedValue(false); // no other USD method → becomes default

      await service.getPayoutMethods(SELLER_ID, STORE_ID);

      expect(methodModel.create).toHaveBeenCalledWith(expect.objectContaining({
        storeId: STORE_ID, type: 'stripe_connect', currency: 'USD',
        externalAccountId: 'acct_123', status: 'active', isDefault: true, autoManaged: true,
      }));
    });

    it('two concurrent loads create ONE method: the loser of the unique-index race is ignored, not an error', async () => {
      stripeConnectService.getPayoutEligibility.mockResolvedValue({ accountId: 'acct_123', eligible: true, status: 'active' });
      methodModel.findOne.mockResolvedValue(null);
      methodModel.exists.mockResolvedValue(false);
      methodModel.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));

      await expect(service.getPayoutMethods(SELLER_ID, STORE_ID)).resolves.toBeDefined();
    });

    it('onModuleInit removes duplicate stripe_connect rows, keeps the oldest and repoints schedules to it', async () => {
      methodModel.aggregate = jest.fn().mockResolvedValue([{ _id: STORE_ID, ids: ['m1', 'm2'], anyDefault: true, n: 2 }]);
      methodModel.deleteMany = jest.fn().mockResolvedValue({});
      methodModel.updateOne = jest.fn().mockResolvedValue({});
      methodModel.createIndexes = jest.fn().mockResolvedValue(undefined);
      scheduleModel.updateMany = jest.fn().mockResolvedValue({});

      await service.onModuleInit();

      expect(scheduleModel.updateMany).toHaveBeenCalledWith({ defaultPayoutMethodId: { $in: ['m2'] } }, { $set: { defaultPayoutMethodId: 'm1' } });
      expect(methodModel.deleteMany).toHaveBeenCalledWith({ _id: { $in: ['m2'] } });
      expect(methodModel.updateOne).toHaveBeenCalledWith({ _id: 'm1' }, { $set: { isDefault: true } });
      expect(methodModel.createIndexes).toHaveBeenCalled();
    });

    it('onModuleInit never throws (boot must not depend on the cleanup)', async () => {
      methodModel.aggregate = jest.fn().mockRejectedValue(new Error('db down'));
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('deactivates a stale auto-managed method once the seller disconnects Stripe entirely', async () => {
      stripeConnectService.getPayoutEligibility.mockResolvedValue(null);
      const existing = { status: 'active', save: jest.fn() };
      methodModel.findOne.mockResolvedValue(existing);

      await service.getPayoutMethods(SELLER_ID, STORE_ID);

      expect(existing.status).toBe('inactive');
      expect(existing.save).toHaveBeenCalled();
    });

    it('requestPayout on a stripe_connect method moves money via a real Stripe Transfer and completes synchronously, no admin step', async () => {
      const method = { _id: 'm-connect', storeId: STORE_ID, status: 'active', currency: 'USD', type: 'stripe_connect', externalAccountId: 'acct_123' };
      methodModel.findById.mockResolvedValue(method);
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);
      stripeConnectService.createTransfer.mockResolvedValue({ id: 'tr_abc123' });

      const payout = await service.requestPayout(SELLER_ID, STORE_ID, { amount: 40, payoutMethodId: 'm-connect' } as any);

      expect(stripeConnectService.createTransfer).toHaveBeenCalledWith(
        'acct_123', 4000, 'USD', `payout-transfer-${payout._id}`,
        expect.objectContaining({ payoutId: String(payout._id), storeId: STORE_ID, sellerId: SELLER_ID }),
      );
      expect(balance.availableBalance).toBe(60); // debited once, never restored — the transfer succeeded
      expect(payout.railType).toBe('stripe_connect');
      expect(payout.status).toBe('completed');
      expect(payout.stripeTransferId).toBe('tr_abc123');
    });

    it('requestPayout on a stripe_connect method reverses the ledger debit when the real Stripe Transfer call fails', async () => {
      const method = { _id: 'm-connect', storeId: STORE_ID, status: 'active', currency: 'USD', type: 'stripe_connect', externalAccountId: 'acct_123' };
      methodModel.findById.mockResolvedValue(method);
      const balance = makeBalance({ availableBalance: 100 });
      balanceModel.findOne.mockResolvedValue(balance);
      stripeConnectService.createTransfer.mockRejectedValue(new Error('destination account is not fully verified'));

      const payout = await service.requestPayout(SELLER_ID, STORE_ID, { amount: 40, payoutMethodId: 'm-connect' } as any);

      // Debited by debitAndCreatePayout, then fully credited back by the failure-reversal path — net zero.
      expect(balance.availableBalance).toBe(100);
      expect(payout.status).toBe('failed');
      expect(payout.failureReason).toContain('not fully verified');
    });

    it('adminApprovePayout refuses to act on a stripe_connect payout — it already resolved itself synchronously', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue({ _id: 'p1', railType: 'stripe_connect', status: 'completed' });
      await expect(service.adminApprovePayout('p1', 'admin-1')).rejects.toThrow(BadRequestException);
    });

    it('adminRejectPayout refuses to act on a stripe_connect payout', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue({ _id: 'p1', railType: 'stripe_connect', status: 'processing' });
      await expect(service.adminRejectPayout('p1', 'admin-1', 'reason')).rejects.toThrow(BadRequestException);
    });

    it('handleConnectTransferReversed flips a completed payout to reversed and credits the balance back', async () => {
      const payout = {
        _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD',
        railType: 'stripe_connect', status: 'completed', stripeTransferId: 'tr_abc123', save: jest.fn(),
      };
      payoutModel.findOne = jest.fn().mockResolvedValue(payout);
      const balance = makeBalance({ availableBalance: 60, totalPayouts: 40 });
      balanceModel.findOne.mockResolvedValue(balance);
      balanceModel.updateOne = jest.fn().mockResolvedValue({});

      await service.handleConnectTransferReversed('tr_abc123');

      expect(payout.status).toBe('reversed');
      expect(balance.availableBalance).toBe(100);
      expect(balance.totalPayouts).toBe(0);
      expect(balanceModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ storeId: STORE_ID, currency: 'USD' }),
        expect.objectContaining({ $set: expect.objectContaining({ isFlaggedForReview: true }) }),
      );
    });

    it('handleConnectTransferReversed swallows a lost race (concurrent delivery already reversed it) without crediting twice', async () => {
      const payout = {
        _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD',
        railType: 'stripe_connect', status: 'completed', stripeTransferId: 'tr_abc123', save: jest.fn(),
      };
      payoutModel.findOne = jest.fn().mockResolvedValue(payout);
      payoutModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
      const balance = makeBalance({ availableBalance: 60, totalPayouts: 40 });
      balanceModel.findOne.mockResolvedValue(balance);

      await expect(service.handleConnectTransferReversed('tr_abc123')).resolves.toBeUndefined();
      expect(balance.availableBalance).toBe(60);
    });

    it('handleConnectTransferReversed is a no-op for an unknown transfer id (ignores an unrelated webhook safely)', async () => {
      payoutModel.findOne = jest.fn().mockResolvedValue(null);
      await expect(service.handleConnectTransferReversed('tr_not_ours')).resolves.toBeUndefined();
    });

    it('adminReverseStripeConnectPayout calls the real Stripe reversal API and only ever applies to a completed stripe_connect payout', async () => {
      const payout = {
        _id: 'p1', storeId: STORE_ID, sellerId: SELLER_ID, amount: 40, currency: 'USD',
        railType: 'stripe_connect', status: 'completed', stripeTransferId: 'tr_abc123', save: jest.fn(),
      };
      payoutModel.findById = jest.fn().mockResolvedValue(payout);
      const balance = makeBalance({ availableBalance: 60, totalPayouts: 40 });
      balanceModel.findOne.mockResolvedValue(balance);
      balanceModel.updateOne = jest.fn().mockResolvedValue({});
      stripeConnectService.reverseTransfer.mockResolvedValue({ id: 'trr_1' });

      await service.adminReverseStripeConnectPayout('p1', 'admin-1', 'confirmed fraud');

      expect(stripeConnectService.reverseTransfer).toHaveBeenCalledWith('tr_abc123', 'payout-reversal-p1');
      expect(payout.status).toBe('reversed');
      expect(balance.availableBalance).toBe(100);
    });

    it('adminReverseStripeConnectPayout rejects a manual-rail or non-completed payout', async () => {
      payoutModel.findById = jest.fn().mockResolvedValue({ _id: 'p1', railType: 'manual', status: 'completed' });
      await expect(service.adminReverseStripeConnectPayout('p1', 'admin-1', 'reason')).rejects.toThrow(BadRequestException);
    });
  });

  describe('adminGetSellerFinancialDetails', () => {
    it('returns every currency balance/schedule the store holds, not just USD', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([
        makeBalance({ currency: 'USD', availableBalance: 50 }),
        makeBalance({ currency: 'PKR', availableBalance: 27800 }),
      ]));
      scheduleModel.find.mockReturnValue(makeChainableFind([
        { currency: 'USD', frequency: 'weekly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null },
        { currency: 'PKR', frequency: 'weekly', isEnabled: true, minimumAmount: 1500, nextPayoutAt: null },
      ]));

      const result = await service.adminGetSellerFinancialDetails(STORE_ID);

      expect(result.balances).toHaveLength(2);
      expect(result.balances.map((b: any) => b.currency)).toEqual(['USD', 'PKR']);
      expect(result.payoutSchedules).toHaveLength(2);
    });

    it('falls back to a zeroed USD placeholder for a brand-new store with no balance doc yet', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([]));

      const result = await service.adminGetSellerFinancialDetails(STORE_ID);

      expect(result.balances).toEqual([expect.objectContaining({ currency: 'USD', availableBalance: 0 })]);
    });
  });

  describe('getDashboard', () => {
    it('defaults to a single zeroed USD wallet for a brand-new store with no balance/schedule docs yet', async () => {
      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets).toHaveLength(1);
      expect(result.wallets[0]).toEqual(expect.objectContaining({ currency: 'USD', availableBalance: 0, pendingBalance: 0 }));
    });

    it('a brand-new PKR store shows a PKR wallet (its own currency), never a phantom USD one', async () => {
      storeModel.findById.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, baseCurrency: 'PKR' });

      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets.map((w: any) => w.currency)).toEqual(['PKR']);
    });

    it('"tax collected" is the real tax stamped on this month\'s sales, not a flat percentage of revenue', async () => {
      txModel.aggregate.mockImplementation(async (pipeline: any[]) => {
        const group = pipeline.find((s) => s.$group)?.$group;
        if (group?.tax) return [{ _id: null, tax: 37.5 }];
        return [{ _id: 'sale', total: 1000, count: 4 }];
      });

      const result: any = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets[0].summary.thisMonthRevenue).toBe(1000);
      expect(result.wallets[0].summary.pendingTax).toBe(37.5); // would be 150 under the old 15% guess
    });

    it('the processing-fee text is clean and follows the store currency', async () => {
      const usd: any = await service.getDashboard(SELLER_ID, STORE_ID);
      expect(usd.feeBreakdown.paymentProcessing).toMatch(/^2\.9% \+ \$0\.30 /);

      storeModel.findById.mockResolvedValue({ _id: STORE_ID, sellerId: SELLER_ID, isDelete: false, baseCurrency: 'PKR' });
      (service as any).db.repositories.exchangeRateModel = {
        findOne: jest.fn().mockReturnValue({ sort: () => ({ select: () => ({ lean: () => Promise.resolve({ ratePerUSD: 280 }) }) }) }),
      };
      const pkr: any = await service.getDashboard(SELLER_ID, STORE_ID);
      expect(pkr.feeBreakdown.paymentProcessing).toMatch(/^2\.9% \+ PKR 84\.00 /);
    });

    it('returns one wallet per currency the store holds, each with its own balance, schedule, and default payout method', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([
        makeBalance({ currency: 'USD', availableBalance: 50 }),
        makeBalance({ currency: 'PKR', availableBalance: 27800 }),
      ]));
      scheduleModel.find.mockReturnValue(makeChainableFind([
        { currency: 'USD', frequency: 'weekly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null },
        { currency: 'PKR', frequency: 'weekly', isEnabled: true, minimumAmount: 1500, nextPayoutAt: null },
      ]));
      methodModel.find.mockReturnValue(makeChainableFind([
        { type: 'bank_transfer', currency: 'USD', isDefault: true, bankName: 'Chase', accountLast4: '1234' },
        { type: 'jazzcash', currency: 'PKR', isDefault: true, bankName: null, accountLast4: null },
      ]));

      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets).toHaveLength(2);
      const usdWallet: any = result.wallets.find((w: any) => w.currency === 'USD');
      const pkrWallet: any = result.wallets.find((w: any) => w.currency === 'PKR');
      expect(usdWallet.availableBalance).toBe(50);
      expect(usdWallet.nextPayout.method.type).toBe('bank_transfer');
      expect(pkrWallet.availableBalance).toBe(27800);
      expect(pkrWallet.nextPayout.method.type).toBe('jazzcash');
    });

    it('does not create a phantom second wallet when a legacy schedule doc predates the currency field (lean reads skip Mongoose defaults)', async () => {
      balanceModel.find.mockReturnValue(makeChainableFind([makeBalance({ currency: 'USD', availableBalance: 50 })]));
      // No `currency` key at all — simulates a doc saved before this field existed on the schema.
      scheduleModel.find.mockReturnValue(makeChainableFind([{ frequency: 'weekly', isEnabled: true, minimumAmount: 5, nextPayoutAt: null }]));

      const result = await service.getDashboard(SELLER_ID, STORE_ID);

      expect(result.wallets).toHaveLength(1);
      expect(result.wallets[0].currency).toBe('USD');
    });
  });

  describe('payout-method defaults are scoped per currency', () => {
    it("adding a store's first PKR method only checks/unsets PKR defaults, never touching the USD default", async () => {
      methodModel.exists = jest.fn().mockResolvedValue(false);
      methodModel.create = jest.fn().mockResolvedValue({ _id: 'm2', currency: 'PKR', isDefault: true });

      await service.addPayoutMethod(SELLER_ID, STORE_ID, { type: 'jazzcash', externalAccountId: '03001234567' } as any);

      expect(methodModel.exists).toHaveBeenCalledWith({ storeId: STORE_ID, currency: 'PKR' });
      expect(methodModel.updateMany).toHaveBeenCalledWith(
        { storeId: STORE_ID, currency: 'PKR', _id: { $ne: 'm2' } },
        { $set: { isDefault: false } },
      );
    });

    it('setting a PKR method as default only clears other PKR defaults, not the USD one', async () => {
      methodModel.findOne = jest.fn().mockResolvedValue({ _id: 'm2', storeId: STORE_ID, currency: 'PKR', isDefault: false, save: jest.fn() });

      await service.setDefaultPayoutMethod(SELLER_ID, STORE_ID, 'm2');

      expect(methodModel.updateMany).toHaveBeenCalledWith({ storeId: STORE_ID, currency: 'PKR' }, { $set: { isDefault: false } });
    });
  });

  describe('adminGetPlatformTransactions — paymentMethodType filter', () => {
    it('resolves matching order ids first and constrains the ledger query to them', async () => {
      orderModel.find.mockReturnValue(makeChainableFind([{ _id: 'order-1' }, { _id: 'order-2' }]));

      await service.adminGetPlatformTransactions({ paymentMethodType: 'manual_bank_transfer' });

      expect(orderModel.find).toHaveBeenCalledWith({ paymentType: 'manual_bank_transfer' });
      expect(txModel.find).toHaveBeenCalledWith(expect.objectContaining({
        referenceId: { $in: ['order-1', 'order-2'] }, referenceType: 'order',
      }));
    });

    it('does not touch the order model at all when no paymentMethodType filter is given', async () => {
      await service.adminGetPlatformTransactions({});
      expect(orderModel.find).not.toHaveBeenCalled();
    });
  });

  describe('updatePayoutMethod', () => {
    it('resets an active method back to pending_verification when the account number changes, clearing prior verification', async () => {
      const method: any = {
        _id: 'm1', storeId: STORE_ID, status: 'active', bankName: 'Chase', accountLast4: '1234',
        verifiedByAdminId: 'admin-1', verifiedAt: new Date(), save: jest.fn(),
      };
      methodModel.findOne.mockResolvedValue(method);

      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { accountNumber: '999999999999' } as any);

      expect(method.status).toBe('pending_verification');
      expect(method.verifiedByAdminId).toBeNull();
      expect(method.verifiedAt).toBeNull();
      expect(method.accountLast4).toBe('9999');
    });

    it('does not touch verification status when nothing sensitive changed (e.g. only accountHolder)', async () => {
      const method: any = {
        _id: 'm1', storeId: STORE_ID, status: 'active', bankName: 'Chase', accountLast4: '1234',
        verifiedByAdminId: 'admin-1', verifiedAt: new Date(), save: jest.fn(),
      };
      methodModel.findOne.mockResolvedValue(method);

      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { accountHolder: 'Jane Seller' } as any);

      expect(method.status).toBe('active');
      expect(method.verifiedByAdminId).toBe('admin-1');
    });

    it('flags an account-title mismatch against the soft check when accountHolder is updated', async () => {
      const method: any = { _id: 'm1', storeId: STORE_ID, status: 'pending_verification', save: jest.fn() };
      methodModel.findOne.mockResolvedValue(method);

      await service.updatePayoutMethod(SELLER_ID, STORE_ID, 'm1', { accountHolder: 'Someone Else Entirely' } as any);

      expect(method.accountTitleMismatchFlagged).toBe(true);
    });
  });
});
