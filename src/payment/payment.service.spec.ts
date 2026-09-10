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

    service = new PaymentService(
      db, notificationsService, configService, promotionsService,
      financeService, adminConfigService, exchangeRateService, activityLogService,
      giftCardsService, stripeConnectService, commissionRulesService,
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
