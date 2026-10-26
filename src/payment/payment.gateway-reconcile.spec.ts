/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { PaymentService, StockUnavailableException } from './payment.service';
import { DatabaseService } from '../database/databaseservice';
import { encryptCredential } from '../common/credential-encryption.util';

const STORE = 'store-A';
const ORIGINAL_ENV = process.env;

function makeService(opts: {
  integration?: any;
  txn?: any;
  provider?: any;
  claim?: any; // result of the atomic refund-key claim (findOneAndUpdate)
  prior?: any[]; // gatewayRefunds already on the transaction
} = {}) {
  const provider = opts.provider ?? { refund: jest.fn().mockResolvedValue({ success: true, refundId: 'rf_1', amount: 100, status: 'succeeded' }), verifyPayment: jest.fn() };
  const registry = { isSupported: jest.fn().mockReturnValue(true), resolve: jest.fn().mockReturnValue(provider) };
  const integration = opts.integration === undefined
    ? { provider: 'razorpay', credentialsEncrypted: encryptCredential(JSON.stringify({ keyId: 'rzp_test_1', keySecret: 's' }), 'INTEGRATIONS'), config: {}, mode: 'sandbox', webhookToken: 'wt' }
    : opts.integration;
  const paymentTransactionModel: any = {
    findOneAndUpdate: jest.fn().mockResolvedValue(opts.claim === undefined ? { _id: 't1' } : opts.claim),
    findById: jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ gatewayRefunds: opts.prior ?? [] }) }) }),
    findOne: jest.fn().mockResolvedValue(opts.txn ?? null),
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  };
  const checkoutModel: any = { findOne: jest.fn(), findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
  const storeIntegrationModel: any = { findOne: jest.fn().mockResolvedValue(integration) };
  const db = { repositories: { paymentTransactionModel, checkoutModel, storeIntegrationModel } } as unknown as DatabaseService;
  const activityLog = { log: jest.fn().mockResolvedValue(undefined) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const moduleRef = { get: jest.fn().mockReturnValue(registry) };
  const service = new PaymentService(
    db, notifications as any, { get: jest.fn() } as any, {} as any, {} as any, {} as any,
    {} as any, activityLog as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    moduleRef as any,
  );
  return { service, provider, registry, paymentTransactionModel, checkoutModel, storeIntegrationModel, activityLog, notifications };
}

const razorTxn = (extra: any = {}) => ({ _id: 't1', paymentType: 'razorpay', amount: 1000, currency: 'INR', providerSessionId: 'plink_1', providerPaymentId: 'pay_1', ...extra });

describe('PaymentService.refundGatewayTransaction', () => {
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('refunds through the gateway API with the gateway payment id (not the session id) and records it once', async () => {
    const { service, provider, paymentTransactionModel } = makeService();
    const res = await service.refundGatewayTransaction(razorTxn(), STORE, 250, 'key-1');
    expect(res.status).toBe('refunded');
    expect(res.refundId).toBe('rf_1');
    expect(res.note).toMatch(/refunded to the original payment method through Razorpay/);
    expect(provider.refund).toHaveBeenCalledWith('pay_1', 250, expect.anything());
    // claimed the key + capacity first, then recorded the outcome and the refunded total
    expect(paymentTransactionModel.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ _id: 't1', 'gatewayRefunds.key': { $ne: 'key-1' } });
    expect(paymentTransactionModel.updateOne.mock.calls[0][1].$inc).toEqual({ amountRefunded: 250 });
  });

  it('falls back to the session id when the gateway never reported a separate payment id', async () => {
    const { service, provider } = makeService();
    await service.refundGatewayTransaction(razorTxn({ providerPaymentId: null }), STORE, 100, 'k');
    expect(provider.refund).toHaveBeenCalledWith('plink_1', 100, expect.anything());
  });

  it('REGRESSION: a gateway without a refund API (PayFast) is a MANUAL refund — the gateway is never called', async () => {
    const { service, provider, registry } = makeService();
    const res = await service.refundGatewayTransaction(razorTxn({ paymentType: 'payfast' }), STORE, 100, 'k');
    expect(res.status).toBe('manual');
    expect(res.note).toMatch(/PayFast.*cannot refund automatically/);
    expect(provider.refund).not.toHaveBeenCalled();
    expect(registry.resolve).not.toHaveBeenCalled();
  });

  it('treats no transaction / Stripe Connect / an unknown type as paid outside the platform (manual)', async () => {
    const { service } = makeService();
    expect((await service.refundGatewayTransaction(null, STORE, 10, 'k')).status).toBe('manual');
    expect((await service.refundGatewayTransaction(razorTxn({ paymentType: 'stripe' }), STORE, 10, 'k')).status).toBe('manual');
    expect((await service.refundGatewayTransaction(razorTxn({ paymentType: 'cash_on_delivery' }), STORE, 10, 'k')).status).toBe('manual');
  });

  it('is manual when the seller disconnected the gateway since the sale', async () => {
    const { service, provider } = makeService({ integration: { provider: 'razorpay', credentialsEncrypted: null } });
    const res = await service.refundGatewayTransaction(razorTxn(), STORE, 100, 'k');
    expect(res.status).toBe('manual');
    expect(res.note).toMatch(/not connected any more/);
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('REGRESSION: the same key never refunds twice (a retried call returns the earlier result)', async () => {
    const { service, provider } = makeService({ claim: null, prior: [{ key: 'key-1', amount: 250, refundId: 'rf_old', status: 'succeeded' }] });
    const res = await service.refundGatewayTransaction(razorTxn(), STORE, 250, 'key-1');
    expect(res).toMatchObject({ status: 'refunded', refundId: 'rf_old' });
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('REGRESSION: never refunds more than is left on the payment (claim refused, no earlier entry for this key)', async () => {
    const { service, provider } = makeService({ claim: null, prior: [] });
    const res = await service.refundGatewayTransaction(razorTxn(), STORE, 5000, 'new-key');
    expect(res.status).toBe('failed');
    expect(res.note).toMatch(/more than is left to refund/);
    expect(provider.refund).not.toHaveBeenCalled();
  });

  it('when the gateway rejects the refund: frees the key for a retry, alerts, and tells the seller to refund by hand', async () => {
    const provider = { refund: jest.fn().mockResolvedValue({ success: false, refundId: '', amount: 100, status: 'failed' }) };
    const { service, paymentTransactionModel, activityLog } = makeService({ provider });
    const res = await service.refundGatewayTransaction(razorTxn(), STORE, 100, 'k');
    expect(res.status).toBe('failed');
    expect(res.note).toMatch(/RAZORPAY REFUND FAILED.*refund .* manually/);
    expect(paymentTransactionModel.updateOne).toHaveBeenCalledWith({ _id: 't1' }, { $pull: { gatewayRefunds: { key: 'k' } } });
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'gateway_refund_failed', isSecurityAlert: true }));
  });

  it('a refund the gateway only queued is reported as started, not finished', async () => {
    const provider = { refund: jest.fn().mockResolvedValue({ success: true, refundId: 'rf_q', amount: 100, status: 'pending' }) };
    const { service } = makeService({ provider });
    const res = await service.refundGatewayTransaction(razorTxn(), STORE, 100, 'k');
    expect(res.status).toBe('refunded');
    expect(res.note).toMatch(/still processing/);
  });
});

describe('PaymentService.refundGatewayPayment', () => {
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('finds the payment by the order it paid for', async () => {
    const { service, provider, paymentTransactionModel } = makeService({ txn: razorTxn() });
    const res = await service.refundGatewayPayment(STORE, 'order-9', 100, 'k');
    expect(res.status).toBe('refunded');
    expect(paymentTransactionModel.findOne.mock.calls[0][0]).toMatchObject({ orderIds: 'order-9', isDelete: false });
    expect(provider.refund).toHaveBeenCalled();
  });

  it('is manual when no payment exists for the order', async () => {
    const { service } = makeService({ txn: null });
    expect((await service.refundGatewayPayment(STORE, 'order-9', 100, 'k')).status).toBe('manual');
  });
});

describe('PaymentService.reconcileGatewaySession', () => {
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  function setup(status: any) {
    const provider = { verifyPayment: jest.fn().mockResolvedValue(status) };
    const ctx = makeService({ provider });
    const spies = {
      assertMatch: jest.spyOn(ctx.service, 'assertGatewayPaymentMatches').mockResolvedValue(undefined),
      finalize: jest.spyOn(ctx.service, 'finalizeGatewayPayment').mockResolvedValue({ orderIds: ['o1'] }),
      fail: jest.spyOn(ctx.service, 'failGatewayPayment').mockResolvedValue(undefined),
    };
    return { ...ctx, provider, spies };
  }

  it('paid + matching amount: creates the order and passes the gateway payment id on (needed for refunds)', async () => {
    const { service, spies } = setup({ status: 'paid', amount: 2000, currency: 'INR', paymentId: 'pay_9' });
    expect(await service.reconcileGatewaySession(STORE, 'razorpay', 'plink_1', 'test')).toBe('paid');
    expect(spies.assertMatch).toHaveBeenCalledWith(expect.objectContaining({ providerSessionId: 'plink_1', storeId: STORE, paidAmount: 2000, paidCurrency: 'INR' }));
    expect(spies.finalize).toHaveBeenCalledWith('plink_1', 'razorpay', 'pay_9');
  });

  it('REGRESSION: an amount/store mismatch throws and never creates an order', async () => {
    const { service, spies } = setup({ status: 'paid', amount: 1, currency: 'INR' });
    spies.assertMatch.mockRejectedValue(new BadRequestException('Payment amount mismatch'));
    await expect(service.reconcileGatewaySession(STORE, 'razorpay', 'plink_1', 'test')).rejects.toThrow('amount mismatch');
    expect(spies.finalize).not.toHaveBeenCalled();
  });

  it('failed: marks the session failed so the buyer can retry', async () => {
    const { service, spies } = setup({ status: 'failed' });
    expect(await service.reconcileGatewaySession(STORE, 'razorpay', 'plink_1', 'return page')).toBe('failed');
    expect(spies.fail).toHaveBeenCalledWith('plink_1', 'razorpay', expect.stringContaining('return page'));
  });

  it('pending, a failing gateway call, or a disconnected gateway: nothing happens', async () => {
    const { service, spies } = setup({ status: 'pending' });
    expect(await service.reconcileGatewaySession(STORE, 'razorpay', 'plink_1', 'x')).toBe('pending');
    expect(spies.finalize).not.toHaveBeenCalled();

    const broken = makeService({ provider: { verifyPayment: jest.fn().mockRejectedValue(new Error('gateway down')) } });
    expect(await broken.service.reconcileGatewaySession(STORE, 'razorpay', 'plink_1', 'x')).toBe('pending');

    const gone = makeService({ integration: null });
    expect(await gone.service.reconcileGatewaySession(STORE, 'razorpay', 'plink_1', 'x')).toBe('pending');
  });
});

describe('PaymentService.finalizeGatewayPayment — out of stock after the buyer paid', () => {
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  function setupFinalize(provider?: any, txnType = 'razorpay') {
    const ctx = makeService({ provider });
    const txn = razorTxn({ paymentType: txnType, userId: 'u1', checkoutId: 'c1' });
    // 1st call claims the pending transaction
    ctx.paymentTransactionModel.findOneAndUpdate.mockImplementation((filter: any) =>
      Promise.resolve(filter.providerSessionId ? txn : { _id: 't1' }),
    );
    ctx.checkoutModel.findOne.mockResolvedValue({ _id: 'c1', status: 'pending', currency: 'INR', items: [{ storeId: STORE }] });
    jest.spyOn(ctx.service as any, 'createOrder').mockRejectedValue(new StockUnavailableException('Out of stock'));
    return { ...ctx, txn };
  }

  it('REGRESSION: refunds the buyer through the gateway, cancels the checkout and creates no order', async () => {
    const { service, provider, paymentTransactionModel, checkoutModel, notifications } = setupFinalize();
    const res = await service.finalizeGatewayPayment('plink_1', 'razorpay', 'pay_1');
    expect(res).toEqual({ orderIds: [] });
    expect(provider.refund).toHaveBeenCalledWith('pay_1', 1000, expect.anything());
    expect(paymentTransactionModel.findByIdAndUpdate).toHaveBeenCalledWith('t1', { status: 'refunded' });
    expect(checkoutModel.findByIdAndUpdate).toHaveBeenCalledWith('c1', { status: 'cancelled' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'u1', title: expect.stringContaining('sold out') }));
  });

  it('a gateway that cannot refund automatically keeps the old behaviour (transaction back to pending, retry later) and raises an alert', async () => {
    const { service, paymentTransactionModel, activityLog } = setupFinalize(undefined, 'payfast');
    await expect(service.finalizeGatewayPayment('plink_1', 'payfast')).rejects.toThrow('Order creation failed, will retry');
    expect(paymentTransactionModel.findByIdAndUpdate).toHaveBeenCalledWith('t1', { status: 'pending', paidAt: null });
    expect(activityLog.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'payment_auto_refund_failed', isSecurityAlert: true }));
  });
});

describe('PaymentService — Stripe Standard connected-account webhook events', () => {
  beforeEach(() => { process.env = { ...ORIGINAL_ENV, INTEGRATIONS_CREDENTIALS_ENCRYPTION_KEY: 'test-key-do-not-use-in-prod' }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });
  function setup(found: any) {
    const ctx = makeService();
    ctx.storeIntegrationModel.findOne = jest.fn().mockReturnValue({ select: () => ({ lean: () => Promise.resolve(found) }) });
    const reconcile = jest.spyOn(ctx.service, 'reconcileGatewaySession').mockResolvedValue('paid');
    return { ...ctx, reconcile };
  }

  it('a checkout.session event of a connected account reconciles the matching store payment (Stripe is asked, not trusted)', async () => {
    const { service, reconcile, storeIntegrationModel } = setup({ storeId: STORE });
    await (service as any).handleConnectedCheckoutEvent('acct_9', { id: 'cs_9' });
    expect(storeIntegrationModel.findOne).toHaveBeenCalledWith({ provider: 'stripe_standard', 'config.accountId': 'acct_9' });
    expect(reconcile).toHaveBeenCalledWith(STORE, 'stripe_standard', 'cs_9', 'stripe webhook');
  });

  it('an account that belongs to no store, or an event without a session, does nothing', async () => {
    const none = setup(null);
    await (none.service as any).handleConnectedCheckoutEvent('acct_x', { id: 'cs_1' });
    expect(none.reconcile).not.toHaveBeenCalled();
    const noSession = setup({ storeId: STORE });
    await (noSession.service as any).handleConnectedCheckoutEvent('acct_9', undefined);
    expect(noSession.reconcile).not.toHaveBeenCalled();
  });
});
