/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { PaymentWebhooksController } from './payment-webhooks.controller';

const STORE = 'store-A';

function setup(eventType: string) {
  const event = { type: eventType, externalEventId: 'evt-1', sessionId: 'track_1', status: { raw: {} } };
  const provider = {
    handleWebhook: jest.fn().mockResolvedValue(event),
    verifyPayment: jest.fn().mockResolvedValue({ status: 'paid', providerReference: 'track_1', amount: 200, currency: 'PKR' }),
  };
  const integration = { provider: 'safepay', storeId: STORE, webhookToken: 'tok', type: 'payment', credentialsEncrypted: null, config: {}, mode: 'sandbox' };
  const db = { repositories: { storeIntegrationModel: { findOne: jest.fn().mockResolvedValue(integration) } } } as any;
  const registry = { isSupported: jest.fn().mockReturnValue(true), resolve: jest.fn().mockReturnValue(provider) } as any;
  const webhookEvents = { recordOnce: jest.fn().mockResolvedValue(true), forget: jest.fn().mockResolvedValue(undefined) };
  const paymentService = {
    assertGatewayPaymentMatches: jest.fn().mockResolvedValue(undefined),
    finalizeGatewayPayment: jest.fn().mockResolvedValue({ orderIds: ['o1'] }),
    failGatewayPayment: jest.fn().mockResolvedValue(undefined),
  };
  const controller = new PaymentWebhooksController(db, registry, webhookEvents as any, paymentService as any);
  const call = () => controller.handle('safepay', 'tok', { rawBody: Buffer.from('{}') } as any, {} as any);
  return { controller, call, provider, webhookEvents, paymentService };
}

describe('PaymentWebhooksController.handle', () => {
  it('finalizes only after the gateway re-confirms the payment AND it matches amount/store', async () => {
    const { call, provider, paymentService } = setup('payment_succeeded');

    await expect(call()).resolves.toEqual({ received: true });

    expect(provider.verifyPayment).toHaveBeenCalledWith('track_1', expect.anything());
    expect(paymentService.assertGatewayPaymentMatches).toHaveBeenCalledWith({
      providerSessionId: 'track_1', paymentType: 'safepay', storeId: STORE, paidAmount: 200, paidCurrency: 'PKR',
    });
    expect(paymentService.finalizeGatewayPayment).toHaveBeenCalledWith('track_1', 'safepay');
  });

  it('REGRESSION: a signed "succeeded" event the gateway does NOT confirm as paid never creates an order', async () => {
    const { call, provider, paymentService } = setup('payment_succeeded');
    provider.verifyPayment.mockResolvedValue({ status: 'pending', providerReference: 'track_1' });

    await expect(call()).rejects.toBeInstanceOf(BadRequestException);

    expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
  });

  it('REGRESSION: an amount/store mismatch blocks the order', async () => {
    const { call, paymentService } = setup('payment_succeeded');
    paymentService.assertGatewayPaymentMatches.mockRejectedValue(new BadRequestException('Payment session does not belong to this store'));

    await expect(call()).rejects.toThrow('does not belong to this store');

    expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
  });

  it('REGRESSION: when processing fails, the dedup row is removed so the gateway retry is processed, not dropped as a duplicate', async () => {
    const { call, webhookEvents, paymentService } = setup('payment_succeeded');
    paymentService.finalizeGatewayPayment.mockRejectedValue(new BadRequestException('Order creation failed, will retry'));

    await expect(call()).rejects.toThrow('will retry');

    expect(webhookEvents.forget).toHaveBeenCalledWith('safepay', 'evt-1');
  });

  it('a duplicate delivery is acknowledged without reprocessing', async () => {
    const { call, webhookEvents, paymentService } = setup('payment_succeeded');
    webhookEvents.recordOnce.mockResolvedValue(false);

    await expect(call()).resolves.toEqual({ received: true, duplicate: true });

    expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
  });

  it('a non-terminal (pending) event is acknowledged and neither recorded nor finalized', async () => {
    const { call, webhookEvents, paymentService, provider } = setup('payment_pending');

    await expect(call()).resolves.toEqual({ received: true, ignored: 'pending' });

    expect(webhookEvents.recordOnce).not.toHaveBeenCalled();
    expect(provider.verifyPayment).not.toHaveBeenCalled();
    expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
  });

  it('a failed-payment event marks the transaction failed', async () => {
    const { call, paymentService } = setup('payment_failed');
    await call();
    expect(paymentService.failGatewayPayment).toHaveBeenCalledWith('track_1', 'safepay', expect.any(String));
  });
});
