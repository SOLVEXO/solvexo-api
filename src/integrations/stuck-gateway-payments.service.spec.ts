/* eslint-disable prettier/prettier */
import { StuckGatewayPaymentsService } from './stuck-gateway-payments.service';
import { DatabaseService } from '../database/databaseservice';
import { GATEWAY_PAYMENT_TYPES } from './payment-provider-catalog';

const lean = (v: any) => ({ lean: jest.fn().mockResolvedValue(v) });
const selectLean = (v: any) => ({ select: jest.fn().mockReturnValue(lean(v)) });

// The per-session decision (ask the gateway, check amount/store, create the order or fail the session) lives in
// PaymentService.reconcileGatewaySession (see payment.gateway-reconcile.spec.ts); this service picks WHICH sessions to
// check, calls it, and alerts the seller when a payment stays unconfirmed.
describe('StuckGatewayPaymentsService', () => {
  const txn = { _id: 't1', checkoutId: 'c1', paymentType: 'payfast', providerSessionId: 'SXABC', amount: 2000, currency: 'PKR' };
  let paymentTransactionModel: any;
  let checkoutModel: any;
  let storeModel: any;
  let paymentService: any;
  let notifications: any;
  let service: StuckGatewayPaymentsService;

  beforeEach(() => {
    paymentTransactionModel = {
      find: jest.fn().mockReturnValue({ sort: () => ({ limit: () => lean([txn]) }) }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    checkoutModel = { findById: jest.fn().mockReturnValue(selectLean({ status: 'pending', items: [{ storeId: 's1' }] })) };
    storeModel = { findById: jest.fn().mockReturnValue(selectLean({ sellerId: 'seller1', name: 'Shop' })) };
    paymentService = { reconcileGatewaySession: jest.fn().mockResolvedValue('pending') };
    notifications = { notify: jest.fn().mockResolvedValue(undefined) };
    const db = { repositories: { paymentTransactionModel, checkoutModel, storeModel } } as unknown as DatabaseService;
    service = new StuckGatewayPaymentsService(db, {} as any, paymentService, notifications, { log: jest.fn().mockResolvedValue(undefined) } as any);
  });

  it('only looks at pending gateway sessions between 1 h and 48 h old that were never alerted', async () => {
    const now = new Date('2026-10-09T12:00:00Z');
    await service.processStuckPayments(now);
    const filter = paymentTransactionModel.find.mock.calls[0][0];
    expect(filter).toMatchObject({ status: 'pending', stuckAlertSentAt: null, paymentType: { $in: GATEWAY_PAYMENT_TYPES.filter((t) => t !== 'stripe') } });
    // Every third-party gateway is covered, Stripe Connect (its own webhook flow) is not.
    for (const t of ['safepay', 'jazzcash', 'payfast', 'easypaisa', 'paypal', 'razorpay', 'paystack', 'flutterwave', 'mollie', 'stripe_own']) {
      expect(filter.paymentType.$in).toContain(t);
    }
    expect(filter.paymentType.$in).not.toContain('stripe');
    expect(filter.createdAt.$lte).toEqual(new Date('2026-10-09T11:00:00Z'));
    expect(filter.createdAt.$gte).toEqual(new Date('2026-10-07T12:00:00Z'));
  });

  it('notifies the store owner once when the gateway still cannot confirm the payment', async () => {
    const res = await service.processStuckPayments();
    expect(res).toEqual({ checked: 1, recovered: 0, alerted: 1 });
    expect(paymentService.reconcileGatewaySession).toHaveBeenCalledWith('s1', 'payfast', 'SXABC', 'stuck-payment check');
    expect(paymentTransactionModel.updateOne).toHaveBeenCalledWith({ _id: 't1', stuckAlertSentAt: null }, expect.anything());
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'seller1', recipientRole: 'seller', storeId: 's1', type: 'payment_unconfirmed' }));
  });

  it('does not notify again when another run already claimed the alert', async () => {
    paymentTransactionModel.updateOne.mockResolvedValue({ modifiedCount: 0 });
    const res = await service.processStuckPayments();
    expect(res.alerted).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('counts a payment the gateway now confirms as recovered and sends no alert', async () => {
    paymentService.reconcileGatewaySession.mockResolvedValue('paid');
    const res = await service.processStuckPayments();
    expect(res.recovered).toBe(1);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('leaves the session for the next run (no order, no alert) when the amount check rejects it', async () => {
    paymentService.reconcileGatewaySession.mockRejectedValue(new Error('amount mismatch'));
    const res = await service.processStuckPayments();
    expect(res).toEqual({ checked: 1, recovered: 0, alerted: 0 });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('sends no alert when the gateway reports the payment as failed', async () => {
    paymentService.reconcileGatewaySession.mockResolvedValue('failed');
    const res = await service.processStuckPayments();
    expect(res.alerted).toBe(0);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('skips (and stops re-checking) a checkout that was already completed another way', async () => {
    checkoutModel.findById.mockReturnValue(selectLean({ status: 'completed', items: [{ storeId: 's1' }] }));
    await service.processStuckPayments();
    expect(paymentService.reconcileGatewaySession).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(paymentTransactionModel.updateOne).toHaveBeenCalledWith({ _id: 't1' }, expect.anything());
  });
});
