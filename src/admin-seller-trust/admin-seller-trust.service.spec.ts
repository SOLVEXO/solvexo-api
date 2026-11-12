/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { AdminSellerTrustService, REMINDER_INTERVAL_MS } from './admin-seller-trust.service';
import { NOTIFICATION_TYPES } from '../notifications/notification.types';

const meta = { adminId: 'admin-1' };

function build(over: { stores?: any[]; settings?: any } = {}) {
  const storeModel: any = {
    find: jest.fn().mockReturnValue({ lean: () => Promise.resolve(over.stores ?? []) }),
    updateOne: jest.fn(),
    aggregate: jest.fn().mockResolvedValue([]),
  };
  const db: any = { repositories: { storeModel, sellerModel: { find: jest.fn() } } };
  const activityLog: any = { log: jest.fn() };
  const notifications: any = { notify: jest.fn().mockResolvedValue(undefined) };
  const settings = over.settings ?? { enforcementStartedAt: null, graceDays: 30 };
  const adminConfig: any = { updateSellerTrustSettings: jest.fn().mockImplementation(async (p: any) => ({ ...settings, ...p })) };
  const sellerTrust: any = {
    getSettings: jest.fn().mockResolvedValue(settings),
    syncDeadlines: jest.fn().mockResolvedValue(undefined),
    recomputeAll: jest.fn().mockResolvedValue({}),
  };
  const service = new AdminSellerTrustService(db, activityLog, notifications, adminConfig, {} as any, {} as any, sellerTrust);
  return { service, storeModel, notifications, adminConfig, sellerTrust, activityLog };
}

const ID_A = '64b000000000000000000001';
const ID_B = '64b000000000000000000002';
const ID_V = '64b000000000000000000003';

describe('AdminSellerTrustService', () => {
  describe('remind', () => {
    it('sends at most one reminder per store per 24h and never to verified stores', async () => {
      const now = new Date('2026-11-11T12:00:00Z');
      const stores = [
        { _id: ID_A, name: 'A', sellerId: 's-a', verificationStatus: 'pending', verificationDueAt: new Date('2026-12-01') },
        { _id: ID_B, name: 'B', sellerId: 's-b', verificationStatus: 'not_started', verificationDueAt: null },
        { _id: ID_V, name: 'V', sellerId: 's-v', verificationStatus: 'verified' },
      ];
      const { service, storeModel, notifications } = build({ stores });
      // A: claim succeeds; B: reminded within the last 24h → the conditional update matches nothing.
      storeModel.updateOne.mockImplementation(async (filter: any) => ({ modifiedCount: filter._id === ID_A ? 1 : 0 }));

      const res = await service.remind({ storeIds: [ID_A, ID_B, ID_V, 'not-an-id'] }, meta, now);

      expect(res.data).toEqual({ sent: 1, skipped: 2 });
      expect(storeModel.updateOne).toHaveBeenCalledTimes(2); // verified store skipped before any write
      const filter = storeModel.updateOne.mock.calls[0][0];
      expect(filter.$or).toEqual([{ lastTrustReminderAt: null }, { lastTrustReminderAt: { $lte: new Date(now.getTime() - REMINDER_INTERVAL_MS) } }]);
      expect(filter.verificationStatus).toEqual({ $ne: 'verified' });
      expect(storeModel.updateOne.mock.calls[0][1].$push['verification.history']).toMatchObject({ action: 'reminder_sent' });
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 's-a', type: NOTIFICATION_TYPES.VERIFICATION_REMINDER }));
    });

    it('needs storeIds or a filter', async () => {
      const { service } = build();
      await expect(service.remind({}, meta)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('summary', () => {
    it('maps the facet counts (missing status = not_started, missing risk = low)', () => {
      const { service } = build();
      const start = new Date('2026-11-01T00:00:00Z');
      const data = service.shapeSummary({
        total: [{ n: 10 }],
        withNtn: [{ n: 4 }],
        byStatus: [{ _id: null, n: 2 }, { _id: 'not_started', n: 1 }, { _id: 'pending', n: 3 }, { _id: 'under_review', n: 1 }, { _id: 'needs_info', n: 1 }, { _id: 'verified', n: 2 }],
        byRisk: [{ _id: 'high', n: 2 }, { _id: 'medium', n: 5 }, { _id: null, n: 3 }],
        deadlinePassed: [{ n: 6 }],
      }, { enforcementStartedAt: start, graceDays: 30 });
      expect(data).toEqual({
        totalStores: 10, withNtn: 4, withoutNtn: 6,
        byStatus: { not_started: 3, pending: 3, under_review: 1, needs_info: 1, verified: 2, rejected: 0 },
        highRisk: 2, mediumRisk: 5, waitingReview: 4, deadlinePassed: 6,
        enforcement: { startedAt: start, graceDays: 30, firstDueAt: new Date('2026-12-01T00:00:00Z') },
      });
    });

    it('empty platform', () => {
      const { service } = build();
      const data = service.shapeSummary({}, { enforcementStartedAt: null, graceDays: 30 });
      expect(data).toMatchObject({ totalStores: 0, withoutNtn: 0, waitingReview: 0, enforcement: { startedAt: null, firstDueAt: null } });
    });
  });

  describe('settings', () => {
    it('"now" starts enforcement and re-syncs deadlines', async () => {
      const { service, adminConfig, sellerTrust } = build();
      const res = await service.updateSettings({ enforcementStartedAt: 'now' }, meta);
      expect(adminConfig.updateSellerTrustSettings.mock.calls[0][0].enforcementStartedAt).toBeInstanceOf(Date);
      expect(sellerTrust.syncDeadlines).toHaveBeenCalled();
      expect(res.data.firstDueAt).toBeInstanceOf(Date);
    });

    it('"now" again keeps the original start date', async () => {
      const { service, adminConfig } = build({ settings: { enforcementStartedAt: new Date('2026-11-01'), graceDays: 30 } });
      await service.updateSettings({ enforcementStartedAt: 'now' }, meta);
      expect(adminConfig.updateSellerTrustSettings.mock.calls[0][0]).toEqual({});
    });

    it('"now" again still re-syncs deadlines (finishes an earlier start that failed half-way)', async () => {
      const { service, sellerTrust } = build({ settings: { enforcementStartedAt: new Date('2026-11-01'), graceDays: 30 } });
      await service.updateSettings({ enforcementStartedAt: 'now' }, meta);
      expect(sellerTrust.syncDeadlines).toHaveBeenCalledTimes(1);
    });

    it('null stops enforcement', async () => {
      const { service, adminConfig, sellerTrust } = build({ settings: { enforcementStartedAt: new Date('2026-11-01'), graceDays: 30 } });
      await service.updateSettings({ enforcementStartedAt: null, graceDays: 14 }, meta);
      expect(adminConfig.updateSellerTrustSettings.mock.calls[0][0]).toEqual({ enforcementStartedAt: null, graceDays: 14 });
      expect(sellerTrust.syncDeadlines).toHaveBeenCalled();
    });
  });

  describe('list filters', () => {
    it('builds the store match from the query', async () => {
      const { service } = build();
      const now = new Date('2026-11-11');
      const m = await service.buildMatch({ country: 'pk', ntn: 'no', status: 'not_started', risk: 'high', limited: 'yes' }, now);
      expect(m.$and).toEqual(expect.arrayContaining([
        { isDelete: false },
        { country: { $in: ['PK', null] } },
        { verificationStatus: { $in: ['not_started', null] } },
        { riskLevel: 'high' },
        { verificationStatus: { $ne: 'verified' }, verificationDueAt: { $ne: null, $lte: now } },
      ]));
      expect(m.$and.some((c: any) => c.$nor)).toBe(true);
    });
  });
});
