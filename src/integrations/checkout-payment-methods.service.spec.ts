/* eslint-disable prettier/prettier */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CheckoutPaymentMethodsService } from './checkout-payment-methods.service';
import { DatabaseService } from '../database/databaseservice';
import { PaymentService } from '../payment/payment.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PaymentProviderRegistry } from './payment-provider.registry';

const USER_ID = 'user-1';

function checkout(items: Array<{ storeId: string; totalPrice: number }>, totalAmount = items.reduce((s, i) => s + i.totalPrice, 0)) {
  return { _id: 'checkout-1', userId: USER_ID, items, totalAmount, currency: 'PKR', status: 'pending' };
}

describe('CheckoutPaymentMethodsService', () => {
  let service: CheckoutPaymentMethodsService;
  let checkoutModel: any;
  let storeIntegrationModel: any;
  let orderModel: any;
  let paymentTransactionModel: any;
  let storeModel: any;
  let registry: PaymentProviderRegistry;
  let paymentService: PaymentService;
  let activityLogService: ActivityLogService;

  beforeEach(() => {
    checkoutModel = { findOne: jest.fn() };
    storeIntegrationModel = { find: jest.fn(), findOne: jest.fn() };
    orderModel = { find: jest.fn().mockResolvedValue([]) };
    paymentTransactionModel = { create: jest.fn().mockResolvedValue({}) };
    storeModel = { findById: jest.fn().mockReturnValue({ select: jest.fn().mockResolvedValue({ baseCurrency: 'PKR' }) }) };
    const db = {
      repositories: { checkoutModel, storeIntegrationModel, orderModel, paymentTransactionModel, storeModel },
    } as unknown as DatabaseService;

    registry = {
      isSupported: jest.fn().mockReturnValue(true),
      resolve: jest.fn().mockReturnValue({ getPublicConfig: () => ({ displayName: 'Safepay', currency: 'PKR' }) }),
    } as any;
    paymentService = {
      finalizeGatewayPayment: jest.fn().mockResolvedValue({ orderIds: ['order-1'] }),
      failGatewayPayment: jest.fn().mockResolvedValue(undefined),
      // The real helper converts checkout.totalAmount with frozen snapshots; here: identity on totalAmount.
      computeGatewayCharge: jest.fn().mockImplementation(async (c: any) => ({ amount: c.totalAmount ?? 0, fxSnapshots: [{ currency: 'PKR', ratePerUSD: 280 }] })),
      assertGatewayPaymentMatches: jest.fn().mockResolvedValue(undefined),
    } as any;
    activityLogService = { log: jest.fn() } as any;

    service = new CheckoutPaymentMethodsService(db, registry, paymentService, activityLogService);
  });

  describe('listPaymentMethods', () => {
    it('throws NotFoundException for a checkout that does not belong to this buyer (ownership check)', async () => {
      checkoutModel.findOne.mockResolvedValue(null);
      await expect(service.listPaymentMethods('checkout-1', USER_ID)).rejects.toThrow(NotFoundException);
      expect(checkoutModel.findOne).toHaveBeenCalledWith({ _id: 'checkout-1', userId: USER_ID, isDelete: false });
    });

    it('returns an empty list for a multi-store checkout instead of guessing which store to route to', async () => {
      checkoutModel.findOne.mockResolvedValue(
        checkout([
          { storeId: 'store-A', totalPrice: 100 },
          { storeId: 'store-B', totalPrice: 200 },
        ]),
      );
      const result = await service.listPaymentMethods('checkout-1', USER_ID);
      expect(result).toEqual({ success: true, data: { currency: null, methods: [] } });
      expect(storeIntegrationModel.find).not.toHaveBeenCalled();
    });

    it('returns only connected + checkout-enabled integrations for a single-store checkout, scoped to that store', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.find.mockResolvedValue([{ provider: 'safepay', config: { displayName: 'Safepay' } }]);

      const result = await service.listPaymentMethods('checkout-1', USER_ID);

      expect(storeIntegrationModel.find).toHaveBeenCalledWith({
        storeId: 'store-A',
        type: 'payment',
        status: 'connected',
        isEnabledForCheckout: true,
      });
      expect(result.data).toEqual({
        currency: 'PKR',
        methods: [{ provider: 'safepay', displayName: 'Safepay', currency: 'PKR' }],
      });
    });

    it('filters out a provider the registry does not actually implement', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.find.mockResolvedValue([{ provider: 'jazzcash', config: {} }]);
      (registry.isSupported as jest.Mock).mockReturnValue(false);

      const result = await service.listPaymentMethods('checkout-1', USER_ID);
      expect(result.data.methods).toEqual([]);
    });

    it("resolves the store's own currency even when nothing is connected yet — the client needs this to gate its OTHER payment options by region too", async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.find.mockResolvedValue([]);
      storeModel.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ baseCurrency: 'USD' }) });

      const result = await service.listPaymentMethods('checkout-1', USER_ID);
      expect(result.data).toEqual({ currency: 'USD', methods: [] });
    });
  });

  describe('initiatePayment', () => {
    it('requires returnUrl and cancelUrl', async () => {
      await expect(service.initiatePayment('checkout-1', USER_ID, 'safepay', '', 'https://x.com/cancel')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a multi-store checkout rather than routing through one store\'s gateway for another store\'s items', async () => {
      checkoutModel.findOne.mockResolvedValue(
        checkout([
          { storeId: 'store-A', totalPrice: 100 },
          { storeId: 'store-B', totalPrice: 50 },
        ]),
      );
      await expect(
        service.initiatePayment('checkout-1', USER_ID, 'safepay', 'https://x.com/r', 'https://x.com/c'),
      ).rejects.toThrow('spans multiple stores');
    });

    it('REGRESSION: charges the checkout FINAL payable total (items + shipping + tax), not just the sum of item prices', async () => {
      // items 150 + shipping 30 + tax 20 = 200 payable
      checkoutModel.findOne.mockResolvedValue(
        checkout([{ storeId: 'store-A', totalPrice: 100 }, { storeId: 'store-A', totalPrice: 50 }], 200),
      );
      storeIntegrationModel.findOne.mockResolvedValue({
        provider: 'safepay',
        credentialsEncrypted: null,
        config: {},
        mode: 'sandbox',
        webhookToken: null,
      });
      const initiatePayment = jest.fn().mockResolvedValue({ redirectUrl: 'https://checkout', sessionId: 'track_1' });
      (registry.resolve as jest.Mock).mockReturnValue({ initiatePayment });

      await service.initiatePayment('checkout-1', USER_ID, 'safepay', 'https://x.com/r', 'https://x.com/c');

      expect(initiatePayment).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 200, currency: 'PKR', storeId: 'store-A' }),
        expect.anything(),
      );
      expect(paymentService.computeGatewayCharge).toHaveBeenCalledWith(expect.objectContaining({ totalAmount: 200 }), 'PKR');
      // The linkage row PaymentWebhooksController -> PaymentService.finalizeGatewayPayment
      // looks up by providerSessionId once the gateway reports an outcome —
      // without this, a successful payment has nothing to attach an Order to.
      expect(paymentTransactionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          checkoutId: 'checkout-1',
          paymentType: 'safepay',
          amount: 200,
          currency: 'PKR',
          fxSnapshots: [{ currency: 'PKR', ratePerUSD: 280 }],
          status: 'pending',
          providerSessionId: 'track_1',
        }),
      );
    });

    it.each(['completed', 'cancelled', 'expired'])('REGRESSION: refuses to open a gateway session on a %s checkout', async (status) => {
      checkoutModel.findOne.mockResolvedValue({ ...checkout([{ storeId: 'store-A', totalPrice: 100 }]), status });
      await expect(
        service.initiatePayment('checkout-1', USER_ID, 'safepay', 'https://x.com/r', 'https://x.com/c'),
      ).rejects.toThrow(/can no longer be paid/);
      expect(paymentTransactionModel.create).not.toHaveBeenCalled();
    });

    it('refuses an initiate for a suspended store', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue({ provider: 'safepay', credentialsEncrypted: null, config: {}, mode: 'sandbox', webhookToken: null });
      storeModel.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ baseCurrency: 'PKR', status: 'suspended' }) });
      await expect(
        service.initiatePayment('checkout-1', USER_ID, 'safepay', 'https://x.com/r', 'https://x.com/c'),
      ).rejects.toThrow('not currently accepting payments');
    });

    it('rejects a provider with no connected, checkout-enabled integration for this store', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue(null);

      await expect(
        service.initiatePayment('checkout-1', USER_ID, 'safepay', 'https://x.com/r', 'https://x.com/c'),
      ).rejects.toThrow('not an available payment method for this store');
    });
  });

  describe('confirmPayment', () => {
    function integrationDoc() {
      return { provider: 'safepay', credentialsEncrypted: null, config: {}, mode: 'sandbox', webhookToken: null };
    }

    it('requires a sessionId', async () => {
      await expect(service.confirmPayment('checkout-1', USER_ID, 'safepay', '')).rejects.toThrow(BadRequestException);
    });

    it('short-circuits to completed without re-verifying if the checkout was already finalized (idempotent for repeated WebView callbacks)', async () => {
      checkoutModel.findOne.mockResolvedValue({ ...checkout([{ storeId: 'store-A', totalPrice: 100 }]), status: 'completed' });
      storeIntegrationModel.findOne.mockResolvedValue(integrationDoc());
      orderModel.find.mockResolvedValue([{ _id: 'order-1' }]);

      const result = await service.confirmPayment('checkout-1', USER_ID, 'safepay', 'track_1');

      expect(result).toEqual({ success: true, data: { status: 'completed', orderIds: ['order-1'] } });
      expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
    });

    it('reports pending status without creating an order when the gateway has not confirmed payment yet', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue(integrationDoc());
      const verifyPayment = jest.fn().mockResolvedValue({ status: 'pending', providerReference: 'track_1' });
      (registry.resolve as jest.Mock).mockReturnValue({ verifyPayment });

      const result = await service.confirmPayment('checkout-1', USER_ID, 'safepay', 'track_1');

      expect(result).toEqual({ success: true, data: { status: 'pending', orderIds: [] } });
      expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
      expect(paymentService.failGatewayPayment).not.toHaveBeenCalled();
    });

    it('marks the PaymentTransaction failed (not left stuck pending) when the gateway reports a failed/refunded status via the buyer-app confirm path', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue(integrationDoc());
      const verifyPayment = jest.fn().mockResolvedValue({ status: 'failed', providerReference: 'track_1' });
      (registry.resolve as jest.Mock).mockReturnValue({ verifyPayment });

      const result = await service.confirmPayment('checkout-1', USER_ID, 'safepay', 'track_1');

      expect(result).toEqual({ success: true, data: { status: 'failed', orderIds: [] } });
      expect(paymentService.failGatewayPayment).toHaveBeenCalledWith('track_1', 'safepay', expect.any(String));
      expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
    });

    it('refuses to create an order when the gateway-confirmed amount does not match the checkout\'s own expected total (the amount/currency safety net)', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue(integrationDoc());
      const verifyPayment = jest.fn().mockResolvedValue({ status: 'paid', providerReference: 'track_1', amount: 999, currency: 'PKR' });
      (registry.resolve as jest.Mock).mockReturnValue({ verifyPayment });
      (paymentService.assertGatewayPaymentMatches as jest.Mock).mockRejectedValue(new BadRequestException('Payment amount mismatch (paid 999, expected 100)'));

      await expect(service.confirmPayment('checkout-1', USER_ID, 'safepay', 'track_1')).rejects.toThrow('amount mismatch');
      expect(paymentService.finalizeGatewayPayment).not.toHaveBeenCalled();
      expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ isSecurityAlert: true, storeId: 'store-A' }));
    });

    it('finalizes via the SAME session-keyed method the webhook uses once the gateway confirms a paid status matching the expected amount', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue(integrationDoc());
      const verifyPayment = jest.fn().mockResolvedValue({ status: 'paid', providerReference: 'track_1', amount: 100, currency: 'PKR' });
      (registry.resolve as jest.Mock).mockReturnValue({ verifyPayment });

      const result = await service.confirmPayment('checkout-1', USER_ID, 'safepay', 'track_1');

      // Verified against the stored transaction (amount/currency charged at initiate) + this store.
      expect(paymentService.assertGatewayPaymentMatches).toHaveBeenCalledWith({
        providerSessionId: 'track_1', paymentType: 'safepay', storeId: 'store-A', paidAmount: 100, paidCurrency: 'PKR',
      });

      // Must be the sessionId-keyed method (same one PaymentWebhooksController
      // calls) — not a separate checkoutId-keyed path, or the PaymentTransaction
      // row created in initiatePayment never gets marked completed whenever
      // this (buyer-app) path wins the race against the webhook, which it
      // usually does.
      expect(paymentService.finalizeGatewayPayment).toHaveBeenCalledWith('track_1', 'safepay');
      expect(result).toEqual({ success: true, data: { status: 'completed', orderIds: ['order-1'] } });
    });
  });
});
