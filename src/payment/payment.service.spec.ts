/* eslint-disable prettier/prettier */
import { PaymentService } from './payment.service';
import { DatabaseService } from '../database/databaseservice';
import { NotificationsService } from '../notifications/notifications.service';
import { ConfigService } from '@nestjs/config';
import { FinanceService } from '../finance/finance.service';
import { AdminConfigService } from '../admin-config/admin-config.service';

const USER_ID = 'user-1';

function makeCheckout(overrides: Partial<Record<string, any>> = {}) {
  return {
    _id: 'checkout-1', userId: USER_ID, status: 'pending', expiredAt: null, currency: 'USD',
    totalAmount: 100, items: [{ type: 'physical', storeId: 'store-1', variantId: 'v1', quantity: 1, name: 'Widget' }],
    ...overrides,
  };
}

describe('PaymentService — COD enforcement', () => {
  let service: PaymentService;
  let checkoutModel: any;
  let storeModel: any;
  let adminConfigService: AdminConfigService;

  beforeEach(() => {
    checkoutModel = { findOne: jest.fn(), findByIdAndUpdate: jest.fn().mockResolvedValue({}) };
    storeModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) };

    const db = { repositories: { checkoutModel, storeModel } } as unknown as DatabaseService;
    const notificationsService = { notify: jest.fn() } as unknown as NotificationsService;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
    const promotionsService = {} as any;
    const financeService = {} as unknown as FinanceService;
    adminConfigService = {} as any;
    const exchangeRateService = {} as any;
    const activityLogService = { log: jest.fn() } as any;
    const giftCardsService = {} as any;
    const stripeConnectService = {} as any;
    const commissionRulesService = {} as any;
    const abandonedCartService = {} as any;
    const affiliateService = {} as any;

    service = new PaymentService(
      db, notificationsService, configService, promotionsService,
      financeService, adminConfigService, exchangeRateService, activityLogService,
      giftCardsService, stripeConnectService, commissionRulesService, abandonedCartService,
      affiliateService, {} as any, {} as any,
    );
  });

  it('rejects a COD order when any store in the cart has opted out of COD', async () => {
    checkoutModel.findOne.mockResolvedValue(makeCheckout());
    storeModel.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{ name: 'Ali Electronics' }]) }) });

    await expect(service.codPayment(USER_ID, { checkoutId: 'checkout-1' })).rejects.toThrow(/Ali Electronics/);
  });

  it('places no ceiling on COD order value — a large order is not blocked by amount', async () => {
    checkoutModel.findOne.mockResolvedValue(makeCheckout({ totalAmount: 50_000 }));
    // No productVariantModel mocked — reaching the stock-check loop with an
    // unmocked model throws a TypeError, which is enough to prove the order
    // got past every COD guard (no store opt-out, no amount ceiling) without
    // needing to mock the entire order-creation path.
    await expect(service.codPayment(USER_ID, { checkoutId: 'checkout-1' })).rejects.toThrow();
    expect(storeModel.find).toHaveBeenCalledWith({ _id: { $in: ['store-1'] }, codEnabled: false });
  });

  it('passes the store opt-out guard and proceeds to the stock-check stage when no stores have opted out', async () => {
    checkoutModel.findOne.mockResolvedValue(makeCheckout({ totalAmount: 50 }));
    await expect(service.codPayment(USER_ID, { checkoutId: 'checkout-1' })).rejects.toThrow();
    expect(storeModel.find).toHaveBeenCalledWith({ _id: { $in: ['store-1'] }, codEnabled: false });
  });
});

describe('PaymentService — manual payment capture', () => {
  let service: PaymentService;
  let orderModel: any;
  let paymentTransactionModel: any;
  let productVariantModel: any;
  let checkoutModel: any;
  let notify: jest.Mock;
  let captureSpy: jest.Mock;

  /** A chainable `.find()` result — supports both a direct `await find(...)`
   *  (markOrdersCaptured/handleAuthorizationCanceled/finalizePaymentIntent)
   *  and `await find(...).lean()` (captureOrderPayment's authorizedTotal
   *  read), matching every real call shape used in payment.service.ts. */
  function makeChainableFind(rows: any[]) {
    const p: any = Promise.resolve(rows);
    p.lean = () => Promise.resolve(rows);
    return p;
  }

  function makeOrder(overrides: Partial<Record<string, any>> = {}): any {
    return {
      _id: 'order-1', orderNumber: 'ORD-1', isPaid: false, paymentStatus: 'authorized', paidAt: null as Date | null,
      totalAmount: 100,
      sellerOrders: [{
        sellerId: 'seller-1', storeId: 'store-1', status: 'pending', cancelledAt: null, cancelReason: null,
        items: [{ type: 'physical', variantId: 'v1', quantity: 2, status: 'pending' }],
      }],
      save: jest.fn().mockImplementation(async function (this: any) { return this; }),
      ...overrides,
    };
  }

  beforeEach(() => {
    orderModel = { find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() };
    paymentTransactionModel = { findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) };
    productVariantModel = { updateOne: jest.fn().mockResolvedValue({}) };
    checkoutModel = {};
    notify = jest.fn().mockResolvedValue(undefined);
    captureSpy = jest.fn().mockResolvedValue({ id: 'pi_1', status: 'succeeded' });

    const db = {
      repositories: { orderModel, paymentTransactionModel, productVariantModel, checkoutModel, storeModel: { findById: jest.fn() } },
    } as unknown as DatabaseService;
    const notificationsService = { notify } as unknown as NotificationsService;
    // A real `sk_test_...`-shaped key makes `assertStripeConfigured()` return
    // a genuine Stripe SDK instance (never makes a network call in these
    // tests) — its `paymentIntents.capture` is then stubbed directly, same
    // as stubbing any other injected dependency.
    const configService = { get: jest.fn().mockReturnValue('sk_test_dummy') } as unknown as ConfigService;

    service = new PaymentService(
      db, notificationsService, configService, {} as any,
      {} as any, {} as any, {} as any, { log: jest.fn() } as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    (service as any).stripe.paymentIntents.capture = captureSpy;
  });

  describe('markOrdersCaptured', () => {
    it('flips an authorized order to paid exactly once', async () => {
      const order = makeOrder();
      orderModel.find.mockResolvedValue([order]);

      await (service as any).markOrdersCaptured(['order-1']);

      expect(order.isPaid).toBe(true);
      expect(order.paymentStatus).toBe('paid');
      expect(order.paidAt).toBeInstanceOf(Date);
      expect(order.save).toHaveBeenCalledTimes(1);
    });

    it('is a safe no-op for an order already captured (redelivered webhook / already ran via the inline capture call)', async () => {
      const order = makeOrder({ isPaid: true });
      orderModel.find.mockResolvedValue([order]);

      await (service as any).markOrdersCaptured(['order-1']);

      expect(order.save).not.toHaveBeenCalled();
    });
  });

  describe('captureOrderPayment', () => {
    it('rejects a seller who does not own this order', async () => {
      orderModel.findOne.mockResolvedValue(makeOrder());
      await expect(service.captureOrderPayment('someone-else', 'order-1')).rejects.toThrow('Unauthorized');
    });

    it('rejects an order that is not in the authorized state', async () => {
      orderModel.findOne.mockResolvedValue(makeOrder({ paymentStatus: 'paid' }));
      await expect(service.captureOrderPayment('seller-1', 'order-1')).rejects.toThrow(/authorized/);
    });

    it('calls the real Stripe capture API for the full authorized amount and flips the order to paid on success', async () => {
      const order = makeOrder();
      orderModel.findOne.mockResolvedValue(order);
      paymentTransactionModel.findOne.mockResolvedValue({ _id: 'tx-1', stripePaymentIntentId: 'pi_1', orderIds: ['order-1'] });
      // First `.find(...).lean()` call resolves the authorized-total lookup;
      // `markOrdersCaptured`'s own `await find(...)` re-uses the same mock.
      orderModel.find.mockReturnValue(makeChainableFind([order]));

      const result = await service.captureOrderPayment('seller-1', 'order-1');

      expect(captureSpy).toHaveBeenCalledWith('pi_1', {});
      expect(paymentTransactionModel.updateOne).toHaveBeenCalledWith(
        { _id: 'tx-1' }, expect.objectContaining({ status: 'completed' }),
      );
      expect(order.isPaid).toBe(true);
      expect(order.totalAmount).toBe(100); // full capture — never scaled down
      expect(result).toEqual({ captured: true, orderIds: ['order-1'], capturedAmount: 100 });
    });

    it('performs a real Stripe PARTIAL capture and proportionally scales the order/sellerOrder amounts down — never credits the seller for money never actually captured', async () => {
      const order = makeOrder();
      orderModel.findOne.mockResolvedValue(order);
      paymentTransactionModel.findOne.mockResolvedValue({ _id: 'tx-1', stripePaymentIntentId: 'pi_1', orderIds: ['order-1'] });
      orderModel.find.mockReturnValue(makeChainableFind([order]));

      const result = await service.captureOrderPayment('seller-1', 'order-1', 60);

      expect(captureSpy).toHaveBeenCalledWith('pi_1', { amount_to_capture: 6000 });
      expect(order.isPaid).toBe(true);
      expect(order.totalAmount).toBe(60);
      expect(result.capturedAmount).toBe(60);
    });

    it('rejects a partial-capture amount larger than what was actually authorized', async () => {
      const order = makeOrder();
      orderModel.findOne.mockResolvedValue(order);
      paymentTransactionModel.findOne.mockResolvedValue({ _id: 'tx-1', stripePaymentIntentId: 'pi_1', orderIds: ['order-1'] });
      orderModel.find.mockReturnValue(makeChainableFind([order]));

      await expect(service.captureOrderPayment('seller-1', 'order-1', 500)).rejects.toThrow(/between 0 and/);
      expect(captureSpy).not.toHaveBeenCalled();
    });

    it('surfaces a real Stripe capture failure (e.g. authorization already expired) without marking anything paid', async () => {
      const order = makeOrder();
      orderModel.findOne.mockResolvedValue(order);
      paymentTransactionModel.findOne.mockResolvedValue({ _id: 'tx-1', stripePaymentIntentId: 'pi_1', orderIds: ['order-1'] });
      orderModel.find.mockReturnValue(makeChainableFind([order]));
      captureSpy.mockRejectedValue(new Error('This PaymentIntent could not be captured because it has already expired.'));

      await expect(service.captureOrderPayment('seller-1', 'order-1')).rejects.toThrow(/expired/);
      expect(order.isPaid).toBe(false);
      expect(paymentTransactionModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe('handleAuthorizationCanceled', () => {
    it('releases the reserved stock and cancels the order when a manual-capture authorization expires uncaptured', async () => {
      paymentTransactionModel.findOneAndUpdate.mockResolvedValue({ orderIds: ['order-1'] });
      const order = makeOrder();
      orderModel.find.mockResolvedValue([order]);

      await (service as any).handleAuthorizationCanceled({ id: 'pi_1' });

      expect(productVariantModel.updateOne).toHaveBeenCalledWith(
        { _id: 'v1' }, { $inc: { committedStock: -2 } },
      );
      expect(order.sellerOrders[0].status).toBe('cancelled');
      expect(order.paymentStatus).toBe('failed');
      expect(order.save).toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'seller-1', type: 'order_cancelled' }));
    });

    it('is a no-op when the PaymentIntent was never actually authorized (nothing to cancel)', async () => {
      paymentTransactionModel.findOneAndUpdate.mockResolvedValue(null);
      await (service as any).handleAuthorizationCanceled({ id: 'pi_unrelated' });
      expect(orderModel.find).not.toHaveBeenCalled();
    });
  });

  describe('finalizePaymentIntent — manual-capture completion branch', () => {
    it('finishes an already-authorized order (flips to paid) without ever touching the checkout/createOrder path', async () => {
      paymentTransactionModel.findOneAndUpdate.mockResolvedValue({ orderIds: ['order-1'] });
      const order = makeOrder();
      orderModel.find.mockResolvedValue([order]);

      const result = await (service as any).finalizePaymentIntent({ id: 'pi_1' });

      expect(result).toEqual({ orderIds: ['order-1'] });
      expect(order.isPaid).toBe(true);
      // The brand-new-order path would have called checkoutModel.findOne —
      // proving that never happened confirms the early-return branch (not a
      // second, duplicate createOrder) is what actually ran.
      expect(checkoutModel.findOne).toBeUndefined();
    });
  });

  describe('getAwaitingCaptureCount', () => {
    it('scopes the count to orders still authorized for this specific store', async () => {
      const storeModel = { findById: jest.fn().mockResolvedValue({ _id: 'store-1', sellerId: 'seller-1', isDelete: false }) };
      (service as any).databaseService.repositories.storeModel = storeModel;
      orderModel.countDocuments.mockResolvedValue(2);

      const count = await service.getAwaitingCaptureCount('store-1', 'seller-1');

      expect(count).toBe(2);
      expect(orderModel.countDocuments).toHaveBeenCalledWith(expect.objectContaining({
        paymentStatus: 'authorized', 'sellerOrders.storeId': 'store-1',
      }));
    });
  });
});
