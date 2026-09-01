/* eslint-disable prettier/prettier */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CheckoutPaymentMethodsService } from './checkout-payment-methods.service';
import { DatabaseService } from '../database/databaseservice';
import { PaymentProviderRegistry } from './payment-provider.registry';

const USER_ID = 'user-1';

function checkout(items: Array<{ storeId: string; totalPrice: number }>) {
  return { _id: 'checkout-1', userId: USER_ID, items };
}

describe('CheckoutPaymentMethodsService', () => {
  let service: CheckoutPaymentMethodsService;
  let checkoutModel: any;
  let storeIntegrationModel: any;
  let registry: PaymentProviderRegistry;

  beforeEach(() => {
    checkoutModel = { findOne: jest.fn() };
    storeIntegrationModel = { find: jest.fn(), findOne: jest.fn() };
    const db = { repositories: { checkoutModel, storeIntegrationModel } } as unknown as DatabaseService;

    registry = {
      isSupported: jest.fn().mockReturnValue(true),
      resolve: jest.fn().mockReturnValue({ getPublicConfig: () => ({ displayName: 'Safepay', currency: 'PKR' }) }),
    } as any;

    service = new CheckoutPaymentMethodsService(db, registry);
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
      expect(result).toEqual({ success: true, data: [] });
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
      expect(result.data).toEqual([{ provider: 'safepay', displayName: 'Safepay', currency: 'PKR' }]);
    });

    it('filters out a provider the registry does not actually implement', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.find.mockResolvedValue([{ provider: 'jazzcash', config: {} }]);
      (registry.isSupported as jest.Mock).mockReturnValue(false);

      const result = await service.listPaymentMethods('checkout-1', USER_ID);
      expect(result.data).toEqual([]);
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

    it('sums only the target store\'s own items into the charge amount, in that store\'s own currency — no FX conversion', async () => {
      checkoutModel.findOne.mockResolvedValue(
        checkout([
          { storeId: 'store-A', totalPrice: 100 },
          { storeId: 'store-A', totalPrice: 50 },
        ]),
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
        expect.objectContaining({ amount: 150, currency: 'PKR', storeId: 'store-A' }),
        expect.anything(),
      );
    });

    it('rejects a provider with no connected, checkout-enabled integration for this store', async () => {
      checkoutModel.findOne.mockResolvedValue(checkout([{ storeId: 'store-A', totalPrice: 100 }]));
      storeIntegrationModel.findOne.mockResolvedValue(null);

      await expect(
        service.initiatePayment('checkout-1', USER_ID, 'safepay', 'https://x.com/r', 'https://x.com/c'),
      ).rejects.toThrow('not an available payment method for this store');
    });
  });
});
