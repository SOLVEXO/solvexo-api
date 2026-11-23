/* eslint-disable prettier/prettier */
import { SellerTrustReminderService } from './seller-trust-reminder.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-12-01T09:30:00Z');
const inDays = (n: number) => new Date(now.getTime() + n * DAY);
const on = { enforcementStartedAt: new Date('2026-11-01'), graceDays: 30 };

const store = (over: any = {}) => ({ _id: 's1', name: 'Ali Traders', sellerId: 'seller-1', verificationDueAt: inDays(3), lastTrustReminderAt: null, trustAutoReminder: null, ...over });

function build(stores: any[], settings: any = on, modified = 1) {
  const chain = { select: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(stores) };
  const storeModel: any = { find: jest.fn().mockReturnValue(chain), updateOne: jest.fn().mockResolvedValue({ modifiedCount: modified }) };
  const db: any = { repositories: { storeModel } };
  const sellerTrust: any = { getSettings: jest.fn().mockResolvedValue(settings) };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const service = new SellerTrustReminderService(db, sellerTrust, notifications);
  return { service, storeModel, notifications };
}

describe('SellerTrustReminderService', () => {
  it('does nothing while enforcement is off (no deadlines exist)', async () => {
    const { service, storeModel, notifications } = build([store()], { enforcementStartedAt: null, graceDays: 30 });
    expect(await service.sendDueReminders(now)).toEqual({ checked: 0, sent: 0, skipped: 0 });
    expect(storeModel.find).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('only looks at stores that still owe an action: never verified or waiting-for-review ones, nor suspended stores', async () => {
    const { service, storeModel } = build([]);
    await service.sendDueReminders(now);
    const filter = storeModel.find.mock.calls[0][0];
    expect(filter.verificationStatus.$in).toEqual(expect.arrayContaining(['not_started', 'needs_info', 'rejected', null]));
    for (const s of ['verified', 'pending', 'under_review']) expect(filter.verificationStatus.$in).not.toContain(s);
    expect(filter).toMatchObject({ isDelete: false, status: { $ne: 'suspended' } });
    expect(filter.verificationDueAt.$lte.getTime()).toBe(inDays(14).getTime());
  });

  it('sends the current stage once: notice, history entry and the stage saved for that deadline', async () => {
    const { service, storeModel, notifications } = build([store()]);
    const res = await service.sendDueReminders(now);
    expect(res).toEqual({ checked: 1, sent: 1, skipped: 0 });
    const [filter, update] = storeModel.updateOne.mock.calls[0];
    expect(filter).toMatchObject({ _id: 's1' });
    expect(update.$set.trustAutoReminder).toMatchObject({ stage: 'd3' });
    expect(update.$set.trustAutoReminder.forDueAt.getTime()).toBe(inDays(3).getTime());
    expect(update.$set.lastTrustReminderAt).toEqual(now);
    expect(update.$push['verification.history']).toMatchObject({ action: 'reminder_auto', note: 'd3' });
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 'seller-1', recipientRole: 'seller', storeId: 's1', type: NOTIFICATION_TYPES.VERIFICATION_REMINDER,
      title: '3 days left to verify your business', data: { storeId: 's1', link: '/store/s1/settings/verification' },
    }));
  });

  it('the same stage is never sent twice for the same deadline, but the next stage is', async () => {
    const same = build([store({ trustAutoReminder: { stage: 'd3', forDueAt: inDays(3), at: inDays(-1) } })]);
    expect(await same.service.sendDueReminders(now)).toEqual({ checked: 1, sent: 0, skipped: 1 });
    expect(same.notifications.notify).not.toHaveBeenCalled();
    const next = build([store({ verificationDueAt: inDays(0.5), trustAutoReminder: { stage: 'd3', forDueAt: inDays(0.5), at: inDays(-2) } })]);
    expect((await next.service.sendDueReminders(now)).sent).toBe(1);
    expect(next.storeModel.updateOne.mock.calls[0][1].$set.trustAutoReminder.stage).toBe('d1');
  });

  it('claims against the previous reminder so a second run cannot send the same one', async () => {
    const at = inDays(-4);
    const { service, storeModel } = build([store({ verificationDueAt: inDays(1), trustAutoReminder: { stage: 'd3', forDueAt: inDays(1), at } })]);
    await service.sendDueReminders(now);
    expect(storeModel.updateOne.mock.calls[0][0]).toMatchObject({ 'trustAutoReminder.at': at });
    const first = build([store()]);
    await first.service.sendDueReminders(now);
    expect(first.storeModel.updateOne.mock.calls[0][0].$or).toEqual([{ trustAutoReminder: null }, { trustAutoReminder: { $exists: false } }]);
  });

  it('when the claim is lost (another run got there first) nothing is sent', async () => {
    const { service, notifications } = build([store()], on, 0);
    expect(await service.sendDueReminders(now)).toEqual({ checked: 1, sent: 0, skipped: 1 });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('leaves a store an admin reminded by hand in the last 24h for the next run', async () => {
    const { service, storeModel, notifications } = build([store({ lastTrustReminderAt: new Date(now.getTime() - 3 * 60 * 60 * 1000) })]);
    expect(await service.sendDueReminders(now)).toEqual({ checked: 1, sent: 0, skipped: 1 });
    expect(storeModel.updateOne).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
    const older = build([store({ lastTrustReminderAt: new Date(now.getTime() - 30 * 60 * 60 * 1000) })]);
    expect((await older.service.sendDueReminders(now)).sent).toBe(1);
  });

  it('a deadline that passed sends the "limited" notice once', async () => {
    const { service, notifications } = build([store({ verificationDueAt: inDays(-2), trustAutoReminder: { stage: 'd1', forDueAt: inDays(-2), at: inDays(-3) } })]);
    expect((await service.sendDueReminders(now)).sent).toBe(1);
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Your store is limited until you verify' }));
    const again = build([store({ verificationDueAt: inDays(-2), trustAutoReminder: { stage: 'limited', forDueAt: inDays(-2), at: inDays(-1) } })]);
    expect((await again.service.sendDueReminders(now)).sent).toBe(0);
  });

  it('a store whose deadline is still far away is skipped', async () => {
    const { service, notifications } = build([store({ verificationDueAt: inDays(30) })]);
    expect(await service.sendDueReminders(now)).toEqual({ checked: 1, sent: 0, skipped: 1 });
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('a failing notification does not stop the other stores', async () => {
    const { service, notifications } = build([store({ _id: 'a', sellerId: 'sa' }), store({ _id: 'b', sellerId: 'sb' })]);
    notifications.notify.mockRejectedValueOnce(new Error('mail down'));
    const res = await service.sendDueReminders(now);
    expect(res.sent).toBe(2);
    expect(notifications.notify).toHaveBeenCalledTimes(2);
  });
});
