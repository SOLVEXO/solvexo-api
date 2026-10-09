/* eslint-disable prettier/prettier */
import { StuckGatewayPaymentsService } from './stuck-gateway-payments.service';
import { DatabaseService } from '../database/databaseservice';

const lean = (v: any) => ({ lean: jest.fn().mockResolvedValue(v) });
const selectLean = (v: any) => ({ select: jest.fn().mockReturnValue(lean(v)) });

describe('StuckGatewayPaymentsService', () => {
  const txn = { _id: 't1', checkoutId: 'c1', paymentType: 'payfast', providerSessionId: 'SXABC', amount: 2000, currency: 'PKR' };
  let paymentTransactionModel: any;
  let checkoutModel: any;
  let storeIntegrationModel: any;
  let storeModel: any;
  let provider: any;
  let paymentService: any;
  let notifications: any;
  let service: StuckGatewayPaymentsService;

  beforeEach(() => {
    paymentTransactionModel = {
      find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => lean([txn]) }) }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    checkoutModel = { findById: jest.fn().mockReturnValue(selectLean({ status: 'pending', items: [{ storeId: 's1' }] })) };
    storeIntegrationModel = { findOne: jest.fn().mockResolvedValue({ provider: 'payfast', credentialsEncrypted: null, config: {}, mode: 'sandbox' }) };
    storeModel = { findById: jest.fn().mockReturnValue(selectLean({ sellerId: 'seller1', name: 'Shop' })) };
    provider = { verifyPayment: jest.fn().mockResolvedValue({ status: 'pending' }) };
    paymentService = {
      assertGatewayPaymentMatches: jest.fn().mockResolvedValue(undefined),
      finalizeGatewayPayment: jest.fn().mockResolvedValue({ orderIds: ['o1'] }),
      failGatewayPayment: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const db = { repositories: { paymentTransactionModel, checkoutModel, storeIntegrationModel, storeModel } } as unknown as DatabaseService;
    const registry: any = { isSupported: () => true, resolve: () => provider };
    service = new StuckGatewayPaymentsService(db, registry, paymentService, notifications, { log: jest.fn().mockResolvedValue(undefined) } as any);
    jest.spyOn(require('./integration-credentials.helper'), 'toDecryptedPaymentConfig').mockReturnValue({ credentials: {}, config: {}, mode: 'sandbox' });
  });

  it('only looks at pending gateway sessions between 1 h and 48 h old that were never alerted', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    await service.processStuckPayments(now);
    const filter = paymentTransactionModel.find.mock.calls[0][0];
    expect(filter).toMatchObject({ status: 'pending', stuckAlertSentAt: null, paymentType: { $in: ['safepay', 'jazzcash', 'payfast', 'easypaisa'] } });
    expect(filter.createdAt.$lte).toEqual(new Date('2026-10-09T11:00:00Z'));
    expect(filter.createdAt.$gte).toEqual(new Date('2026-10-07T12:00:00Z'));
  });

  it('notifies the store owner once when the gateway still cannot confirm the payment', async () => {
    const res = await service.processStuckPayments();
    expect(res).toEqual({ checked: 1, recovered: 0, alerted: 1 });
    expect(paymentTransactionModel.updateOne).toHaveBeenCalledWith({ _id: 't1', stuckAlertSentAt: null }, expect.anything());
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'seller1', recipientRole: 'seller', storeId: 's1', type: 'payment_unconfirmed' }));
    expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
  });

  it('does not notify again when another run already claimed the alert', async () => {
    paymentTransactionModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const res = await service.processStuckPayments();
    expect(res.alerted).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('creates the order when the gateway now confirms the payment and the amount matches', async () => {
    provider.verifyPayment.mockResolvedValue({ status: 'paid', amount: 2000, currency: 'PKR' });
    const res = await service.processStuckPayments();
    expect(paymentService.assertGatewayPaymentMatches).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'SXABC', storeId: 's1', paidAmount: 2000 }));
    expect(paymentService.finalizeGatewayPayment).toHaveBeenCalledWith('SXABC', 'payfast');
    expect(res.recovered).toBe(1);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('never creates an order when the confirmed amount does not match', async () => {
    provider.verifyPayment.mockResolvedValue({ status: 'paid', amount: 1, currency: 'PKR' });
    paymentService.assertGatewayPaymentMatches.mockRejectedValue(new Error('amount mismatch'));
    const res = await service.processStuckPayments();
    expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
    expect(res).toEqual({ checked: 1, recovered: 0, alerted: 0 });
  });

  it('marks the session failed when the gateway reports a failure', async () => {
    provider.verifyPayment.mockResolvedValue({ status: 'failed' });
    await service.processStuckPayments();
    expect(paymentService.failGatewayPayment).toHaveBeenCalledWith('SXABC', 'payfast', expect.any(String));
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('skips (and stops re-checking) a checkout that was already completed another way', async () => {
    checkoutModel.findById.mockReturnValue(selectLean({ status: 'completed', items: [{ storeId: 's1' }] }));
    await service.processStuckPayments();
    expect(provider.verifyPayment).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(paymentTransactionModel.updateOne).toHaveBeenCalledWith({ _id: 't1' }, expect.anything());
  });
});
