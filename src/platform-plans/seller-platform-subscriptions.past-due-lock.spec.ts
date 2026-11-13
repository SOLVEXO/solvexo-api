/* eslint-disable prettier/prettier */
import { SellerPlatformSubscriptionsService, PAST_DUE_LOCK_DAYS } from './seller-platform-subscriptions.service';

/**
 * Unpaid renewal -> 'past_due' must turn into 'locked' after PAST_DUE_LOCK_DAYS
 * (before: only after 8 distinct failed invoices, so an unpaid store kept selling).
 */
describe('SellerPlatformSubscriptionsService — lockOverduePastDue', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const leanOf = (value: any) => ({ lean: jest.fn().mockResolvedValue(value) });
  const selectLeanOf = (value: any) => ({ select: jest.fn(() => leanOf(value)) });
  const doc = (o: Record<string, any>): any => ({ ...o, save: jest.fn().mockResolvedValue(undefined) });

  function make(rows: any[]) {
    const subModel = { find: jest.fn().mockResolvedValue(rows) };
    const planModel = { findById: jest.fn(() => selectLeanOf({ gracePeriodDays: 3 })) };
    const storeModel = { findById: jest.fn(() => selectLeanOf({ name: 'Shop' })) };
    const sellerModel = { findById: jest.fn(() => selectLeanOf({ name: 'Sam', email: 'sam@test.com' })) };
    const notifications = { sendStoreLocked: jest.fn().mockResolvedValue(undefined) };
    const notificationsService = { notify: jest.fn(() => ({ catch: jest.fn() })), notifyAdmins: jest.fn(() => ({ catch: jest.fn() })) };
    const activityLogService = { log: jest.fn() };
    const db: any = { repositories: { sellerPlatformSubscriptionModel: subModel, platformPlanModel: planModel, storeModel, sellerModel } };
    const service = new (SellerPlatformSubscriptionsService as any)(
      db, { isProviderDrivenBilling: true }, activityLogService, notifications, notificationsService,
      { send: jest.fn().mockResolvedValue(undefined) }, { transaction: jest.fn((fn: any) => fn({})) },
    );
    return { service, subModel, notifications, notificationsService, activityLogService };
  }

  const NOW = new Date('2026-11-11T00:00:00Z');
  const base = { sellerId: 's1', storeId: 'st1', platformPlanId: 'p1', status: 'past_due', failedPaymentAttempts: 1 };

  it('queries only past_due, live, non-legacy-free subscriptions', async () => {
    const { service, subModel } = make([]);
    await service.lockOverduePastDue(NOW);
    expect(subModel.find).toHaveBeenCalledWith({ status: 'past_due', isDelete: false, legacyFreeEligible: { $ne: true } });
  });

  it('locks a store unpaid longer than the limit, sets the grace countdown and notifies', async () => {
    const sub = doc({ ...base, _id: 'a', pastDueSince: new Date(NOW.getTime() - (PAST_DUE_LOCK_DAYS + 1) * DAY) });
    const { service, notifications, notificationsService, activityLogService } = make([sub]);
    const res = await service.lockOverduePastDue(NOW);
    expect(res.locked).toBe(1);
    expect(sub.status).toBe('locked');
    expect(sub.lockedAt).toBeInstanceOf(Date);
    expect(sub.pastDueSince).toBeNull();
    expect(sub.gracePeriodEndsAt).toBeInstanceOf(Date);
    expect(sub.save).toHaveBeenCalled();
    expect(notifications.sendStoreLocked).toHaveBeenCalledTimes(1);
    expect(notificationsService.notify).toHaveBeenCalledTimes(1);
    expect(notificationsService.notifyAdmins).toHaveBeenCalledTimes(1);
    expect(activityLogService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'plan_locked_past_due' }));
  });

  it('does NOT lock a store still inside the limit', async () => {
    const sub = doc({ ...base, _id: 'b', pastDueSince: new Date(NOW.getTime() - (PAST_DUE_LOCK_DAYS - 1) * DAY) });
    const { service, notifications } = make([sub]);
    const res = await service.lockOverduePastDue(NOW);
    expect(res.locked).toBe(0);
    expect(sub.status).toBe('past_due');
    expect(sub.save).not.toHaveBeenCalled();
    expect(notifications.sendStoreLocked).not.toHaveBeenCalled();
  });

  it('falls back to currentPeriodEnd for rows that became past_due before pastDueSince existed (the Oct 30 case)', async () => {
    const sub = doc({ ...base, _id: 'c', pastDueSince: null, currentPeriodEnd: new Date('2026-10-30T00:00:00Z') });
    const { service } = make([sub]);
    const res = await service.lockOverduePastDue(NOW);
    expect(res.locked).toBe(1);
    expect(sub.status).toBe('locked');
  });

  it('skips a row with no usable date instead of locking it blindly', async () => {
    const sub = doc({ ...base, _id: 'd', pastDueSince: null, currentPeriodEnd: null });
    const { service } = make([sub]);
    expect((await service.lockOverduePastDue(NOW)).locked).toBe(0);
    expect(sub.status).toBe('past_due');
  });

  it('one failing store does not stop the others', async () => {
    const bad = doc({ ...base, _id: 'e', pastDueSince: new Date(NOW.getTime() - 20 * DAY) });
    bad.save = jest.fn().mockRejectedValue(new Error('db down'));
    const good = doc({ ...base, _id: 'f', storeId: 'st2', pastDueSince: new Date(NOW.getTime() - 20 * DAY) });
    const { service } = make([bad, good]);
    const res = await service.lockOverduePastDue(NOW);
    expect(res.locked).toBe(1);
    expect(good.status).toBe('locked');
  });
});
