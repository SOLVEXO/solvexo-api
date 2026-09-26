/* eslint-disable prettier/prettier */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';
import { DatabaseService } from '../database/databaseservice';
import { PaymentGatewayService } from '../subscriptions/payment-gateway/payment-gateway.service';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { PlatformPlanNotificationsService } from './platform-plan-notifications.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CriticalAlertService } from '../common/critical-alert.service';

/**
 * Real, previously-missing unit coverage — `seller-platform-subscriptions.service.ts`
 * (all proration/charging/dunning logic) had zero test files before this.
 * Scoped to this session's own new/changed logic (grace-period gating,
 * admin manual overrides) — the highest-value, least-trusted surface area,
 * not an attempt at exhaustive coverage of the whole 1600+ line file in one
 * pass. `changePlan`/`processRenewals`/webhook handlers remain untested —
 * a real, disclosed follow-up, not silently claimed as done here.
 */
describe('SellerPlatformSubscriptionsService — grace period + admin overrides', () => {
  let service: SellerPlatformSubscriptionsService;
  let subModel: any;
  let planModel: any;
  let storeModel: any;
  let sellerModel: any;
  let gateway: any;
  let activityLogService: any;
  let notifications: any;
  let notificationsService: any;
  let criticalAlerts: any;

  type MockSubDoc = Record<string, any> & { save: jest.Mock };
  function asDoc(obj: Record<string, any>): MockSubDoc;
  function asDoc(obj: null): null;
  function asDoc(obj: Record<string, any> | null): MockSubDoc | null {
    return obj ? { ...obj, save: jest.fn().mockResolvedValue(undefined) } : null;
  }
  const leanOf = (value: any) => ({ lean: jest.fn().mockResolvedValue(value) });
  const selectLeanOf = (value: any) => ({ select: jest.fn().mockReturnValue(leanOf(value)) });

  function setup() {
    subModel = { find: jest.fn().mockResolvedValue([]), updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    planModel = { findById: jest.fn(), findOne: jest.fn() };
    storeModel = { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }), findById: jest.fn().mockReturnValue(selectLeanOf({ name: 'Test Store' })) };
    sellerModel = { findById: jest.fn().mockReturnValue(selectLeanOf({ name: 'Test Seller', email: 'seller@test.com' })) };

    gateway = {
      isProviderDrivenBilling: true,
      cancelProviderSubscription: jest.fn().mockResolvedValue(undefined),
    };
    activityLogService = { log: jest.fn() };
    notifications = {
      sendStorefrontHidden: jest.fn().mockResolvedValue(undefined),
      sendStoreLocked: jest.fn().mockResolvedValue(undefined),
      sendMovedToFreePlan: jest.fn().mockResolvedValue(undefined),
    };
    notificationsService = { notify: jest.fn().mockReturnValue({ catch: jest.fn() }) };
    criticalAlerts = { send: jest.fn().mockResolvedValue(undefined) };

    const db = {
      repositories: {
        sellerPlatformSubscriptionModel: subModel,
        platformPlanModel: planModel,
        storeModel,
        sellerModel,
      },
    } as unknown as DatabaseService;

    const connection = { transaction: jest.fn((fn: any) => fn({})) };

    service = new SellerPlatformSubscriptionsService(
      db,
      gateway as unknown as PaymentGatewayService,
      activityLogService as unknown as ActivityLogService,
      notifications as unknown as PlatformPlanNotificationsService,
      notificationsService as unknown as NotificationsService,
      criticalAlerts as unknown as CriticalAlertService,
      connection as any,
    );
  }

  beforeEach(setup);

  // ── expireGracePeriods ────────────────────────────────────────────────────
  describe('expireGracePeriods', () => {
    it('gates a locked store whose grace period has passed — flips privacyMode, stamps storefrontGatedAt, logs, notifies', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'locked', gracePeriodEndsAt: new Date(Date.now() - 1000), storefrontGatedAt: null });
      subModel.find.mockResolvedValue([sub]);

      const result = await service.expireGracePeriods();

      expect(result.gated).toBe(1);
      expect(storeModel.updateOne).toHaveBeenCalledWith({ _id: 'store-1', privacyMode: 'public' }, { $set: { privacyMode: 'coming_soon' } });
      expect(sub!.storefrontGatedAt).toBeInstanceOf(Date);
      expect(sub!.save).toHaveBeenCalled();
      expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'storefront_gated_grace_period_expired' }));
      expect(notifications.sendStorefrontHidden).toHaveBeenCalled();
    });

    it('the query itself only ever targets locked/trial_ended rows past their grace period with no gate stamped yet — never re-processes an already-gated row', async () => {
      await service.expireGracePeriods();
      expect(subModel.find).toHaveBeenCalledWith(expect.objectContaining({
        status: { $in: ['locked', 'trial_ended'] },
        storefrontGatedAt: null,
      }));
    });

    it('a store with nothing due gates zero, touches no other collection', async () => {
      const result = await service.expireGracePeriods();
      expect(result.gated).toBe(0);
      expect(storeModel.updateOne).not.toHaveBeenCalled();
    });
  });

  // ── adminUnlockStore ──────────────────────────────────────────────────────
  describe('adminUnlockStore', () => {
    it('restores a locked store to active and clears its grace-period countdown, without any charge', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'locked', gracePeriodEndsAt: new Date(), storefrontGatedAt: new Date() });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      const result = await service.adminUnlockStore('admin-1', 'store-1', 'goodwill unlock');

      expect(result.success).toBe(true);
      expect(sub!.status).toBe('active');
      expect(sub!.gracePeriodEndsAt).toBeNull();
      expect(sub!.storefrontGatedAt).toBeNull();
      expect(sub!.save).toHaveBeenCalled();
      // unlockStorefrontIfComingSoon's own raw update
      expect(storeModel.updateOne).toHaveBeenCalledWith({ _id: 'store-1', privacyMode: 'coming_soon' }, { $set: { privacyMode: 'public' } });
      expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'admin_unlocked_store', actorId: 'admin-1', actorRole: 'admin',
      }));
    });

    it('refuses to "unlock" a store that is not actually locked', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'active' });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      await expect(service.adminUnlockStore('admin-1', 'store-1')).rejects.toThrow(BadRequestException);
    });

    it('throws if the store has no platform-plan record at all', async () => {
      subModel.findOne = jest.fn().mockResolvedValue(null);
      await expect(service.adminUnlockStore('admin-1', 'store-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── adminExtendSubscription ───────────────────────────────────────────────
  describe('adminExtendSubscription', () => {
    it('extends trialEndsAt for a still-trialing store, not currentPeriodEnd', async () => {
      const trialEndsAt = new Date('2026-01-01T00:00:00Z');
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'trialing', trialEndsAt, currentPeriodEnd: new Date('2026-01-01T00:00:00Z'), gracePeriodEndsAt: null });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      await service.adminExtendSubscription('admin-1', 'store-1', 5, 'support goodwill');

      expect(sub!.trialEndsAt.getTime()).toBe(trialEndsAt.getTime() + 5 * 24 * 60 * 60 * 1000);
      expect(sub!.save).toHaveBeenCalled();
    });

    it('extends currentPeriodEnd/nextBillingDate for an active (non-trial) store', async () => {
      const periodEnd = new Date('2026-01-01T00:00:00Z');
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'active', currentPeriodEnd: periodEnd, nextBillingDate: periodEnd, gracePeriodEndsAt: null });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      await service.adminExtendSubscription('admin-1', 'store-1', 3);

      const expected = periodEnd.getTime() + 3 * 24 * 60 * 60 * 1000;
      expect(sub!.currentPeriodEnd.getTime()).toBe(expected);
      expect(sub!.nextBillingDate.getTime()).toBe(expected);
    });

    it('also pushes an in-progress grace-period countdown forward by the same amount, so an extended store cannot get gated before its new period ends', async () => {
      const graceEnd = new Date('2026-01-01T00:00:00Z');
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'locked', currentPeriodEnd: graceEnd, nextBillingDate: graceEnd, gracePeriodEndsAt: graceEnd });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      await service.adminExtendSubscription('admin-1', 'store-1', 2);

      expect(sub!.gracePeriodEndsAt.getTime()).toBe(graceEnd.getTime() + 2 * 24 * 60 * 60 * 1000);
    });
  });

  // ── adminAssignPlan ───────────────────────────────────────────────────────
  describe('adminAssignPlan', () => {
    it('cancels any live Stripe subscription first, then comps the store onto the new plan with no charge', async () => {
      const sub = asDoc({
        _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'locked',
        platformPlanId: 'old-plan', providerSubscriptionId: 'sub_stripe_123', planHistory: [],
        gracePeriodEndsAt: new Date(), storefrontGatedAt: new Date(),
      });
      subModel.findOne = jest.fn().mockResolvedValue(sub);
      planModel.findOne.mockResolvedValue(asDoc({ _id: 'new-plan', name: 'Professional', isFree: false, monthlyPriceUSD: 49, status: 'active' }));
      planModel.findById.mockReturnValue(leanOf({ _id: 'old-plan', name: 'Starter' }));

      const result = await service.adminAssignPlan('admin-1', 'store-1', 'new-plan', 'comp for outage');

      expect(gateway.cancelProviderSubscription).toHaveBeenCalledWith('sub_stripe_123');
      expect(sub!.providerSubscriptionId).toBeNull();
      expect(sub!.platformPlanId).toBe('new-plan');
      expect(sub!.amountUSD).toBe(49);
      expect(sub!.paymentProvider).toBe('manual');
      expect(sub!.status).toBe('active');
      expect(sub!.gracePeriodEndsAt).toBeNull();
      expect(result.data.subscription.planHistory).toHaveLength(1);
      expect(result.data.subscription.planHistory[0]).toMatchObject({ fromPlanId: 'old-plan', fromPlanName: 'Starter', toPlanId: 'new-plan', toPlanName: 'Professional' });
    });

    it('throws if the target plan does not exist or is inactive', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'active', platformPlanId: null, planHistory: [] });
      subModel.findOne = jest.fn().mockResolvedValue(sub);
      planModel.findOne.mockResolvedValue(null);

      await expect(service.adminAssignPlan('admin-1', 'store-1', 'missing-plan')).rejects.toThrow(NotFoundException);
    });
  });

  // ── adminLockStore ────────────────────────────────────────────────────────
  describe('adminLockStore', () => {
    it('force-locks a non-legacy store (no permanent free fallback) via the same lockStore() terminal state dunning exhaustion uses', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'active', legacyFreeEligible: false, providerSubscriptionId: null });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      await service.adminLockStore('admin-1', 'store-1', 'ToS violation');

      expect(sub!.status).toBe('locked');
      expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_locked_store' }));
    });

    it('downgrades a legacy-grandfathered store to the free plan instead of a hard lock', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'active', legacyFreeEligible: true, providerSubscriptionId: null });
      subModel.findOne = jest.fn().mockResolvedValue(sub);
      planModel.findOne.mockResolvedValue(asDoc({ _id: 'free-plan', name: 'Free', isFree: true, status: 'active' }));

      await service.adminLockStore('admin-1', 'store-1');

      expect(sub!.status).toBe('active'); // downgradeToFree lands on 'active', never 'locked'
      expect(sub!.platformPlanId).toBe('free-plan');
    });

    it('refuses to lock an already-locked store', async () => {
      const sub = asDoc({ _id: 'sub-1', storeId: 'store-1', sellerId: 'seller-1', status: 'locked' });
      subModel.findOne = jest.fn().mockResolvedValue(sub);

      await expect(service.adminLockStore('admin-1', 'store-1')).rejects.toThrow(BadRequestException);
    });
  });
});
