/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { PlatformAddonsService } from './platform-addons.service';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AiCreditsService } from './ai-credits.service';

describe('PlatformAddonsService — only real add-ons are sold or renewed', () => {
  let service: PlatformAddonsService;
  let addonModel: any;
  let gateway: any;
  let aiCredits: any;
  let activityLog: any;

  beforeEach(() => {
    addonModel = { find: jest.fn(), create: jest.fn() };
    gateway = { chargeSubscription: jest.fn().mockResolvedValue({ success: true, providerChargeId: 'ch_1' }) };
    aiCredits = { grant: jest.fn().mockResolvedValue(undefined) };
    activityLog = { log: jest.fn() };
    const db = {
      repositories: {
        platformAddonPurchaseModel: addonModel,
        storeModel: { findById: jest.fn().mockResolvedValue({ _id: 'store-1', sellerId: 'seller-1', isDelete: false, badges: [] }) },
        sellerPlatformSubscriptionModel: { findOne: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as DatabaseService;
    service = new PlatformAddonsService(
      db,
      gateway as unknown as PaymentGatewayService,
      activityLog as unknown as ActivityLogService,
      aiCredits as unknown as AiCreditsService,
    );
  });

  it('the catalog lists only Extra AI Credits, with its real price', () => {
    const { data } = service.getAddonCatalog();
    expect(data).toEqual([expect.objectContaining({ addonType: 'extra_ai_credits', priceUSD: 10, recurring: false })]);
  });

  it('refuses to sell a discontinued add-on even if the request bypasses the DTO', async () => {
    await expect(
      service.purchaseAddon('seller-1', 'store-1', { addonType: 'sms_notifications' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(gateway.chargeSubscription).not.toHaveBeenCalled();
  });

  it('a due discontinued add-on is canceled without being charged again', async () => {
    const addon = { _id: 'a1', storeId: 'store-1', addonType: 'advanced_tax_compliance', priceUSD: 15, status: 'active', nextBillingDate: new Date(0), save: jest.fn() };
    addonModel.find.mockResolvedValue([addon]);

    const result = await service.processRecurringAddonRenewals();

    expect(gateway.chargeSubscription).not.toHaveBeenCalled();
    expect(addon.status).toBe('canceled');
    expect(addon.nextBillingDate).toBeNull();
    expect(addon.save).toHaveBeenCalled();
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 0 });
  });
});
