/* eslint-disable prettier/prettier */
import { BadRequestException } from '@nestjs/common';
import { AdminClientsService } from './admin-clients.service';
import { DatabaseService } from '../database/databaseservice';
import { AdminUsersService } from '../admin-users/admin-users.service';
import { AdminAnalyticsService } from '../admin-analytics/admin-analytics.service';
import { AdminFinanceService } from '../admin-finance/admin-finance.service';
import { SellerPlatformSubscriptionsService } from '../platform-plans/seller-platform-subscriptions.service';
import { AdminModerationService } from '../admin-moderation/admin-moderation.service';

// This service composes the admin "Clients" workspace out of already-existing
// sellerId-scoped services (Users/Analytics/Finance/platform-plans) plus its
// own moderation/activity resolution. The activity-query tests below exist
// because of a real bug caught during the architecture preflight: several
// admin actions (seller/store suspend, moderation review/approve/remove) log
// with `storeId: 'platform'`, so a naive `storeId IN [...]` filter silently
// drops them. The fix constrains each platform-scoped clause to its own
// exact, verified `action` name — these tests prove that constraint holds,
// not just that "some query runs".

const SELLER_ID = 'seller-1';
const OTHER_SELLER_ID = 'seller-2';

function findChain(result: any[]) {
  return { select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }) };
}

describe('AdminClientsService', () => {
  let service: AdminClientsService;
  let storeModel: any;
  let productModel: any;
  let ratingModel: any;
  let reportModel: any;
  let activityLogModel: any;
  let db: DatabaseService;
  let adminUsersService: AdminUsersService;
  let adminAnalyticsService: AdminAnalyticsService;
  let adminFinanceService: AdminFinanceService;
  let sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService;
  let adminModerationService: AdminModerationService;

  beforeEach(() => {
    storeModel = { find: jest.fn() };
    productModel = { find: jest.fn() };
    ratingModel = { find: jest.fn() };
    reportModel = { find: jest.fn(), countDocuments: jest.fn().mockResolvedValue(0) };
    activityLogModel = {
      countDocuments: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockReturnValue({ sort: jest.fn().mockReturnValue({ skip: jest.fn().mockReturnValue({ limit: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }) }) }),
    };

    db = { repositories: { storeModel, productModel, ratingModel, reportModel, activityLogModel } } as any;
    adminUsersService = {} as any;
    adminAnalyticsService = {} as any;
    adminFinanceService = {} as any;
    sellerPlatformSubscriptionsService = {} as any;
    adminModerationService = { enrich: jest.fn().mockImplementation((reports: any[]) => Promise.resolve(reports)) } as any;

    service = new AdminClientsService(
      db, adminUsersService, adminAnalyticsService, adminFinanceService, sellerPlatformSubscriptionsService, adminModerationService,
    );
  });

  it('rejects a malformed sellerId before running any query (400, not an unscoped fallback)', async () => {
    await expect(service.getActivity('not-a-real-id', {} as any)).rejects.toThrow(BadRequestException);
    expect(storeModel.find).not.toHaveBeenCalled();
  });

  describe('getActivity — corrected query shape', () => {
    // A realistic 24-hex-char ObjectId-shaped string so isValidObjectId passes.
    const sellerId = '507f1f77bcf86cd799439011';

    function setup(storeIds: string[], productIds: string[] = [], ratingIds: string[] = [], reportIds: string[] = []) {
      storeModel.find.mockReturnValue(findChain(storeIds.map((_id) => ({ _id }))));
      productModel.find.mockReturnValue(findChain(productIds.map((_id) => ({ _id }))));
      ratingModel.find.mockReturnValue(findChain(ratingIds.map((_id) => ({ _id }))));
      reportModel.find.mockReturnValue(findChain(reportIds.map((_id) => ({ _id }))));
    }

    it('scopes stores strictly to this seller (test 7 — another client\'s stores never enter the id list)', async () => {
      setup(['store-a', 'store-b']);
      await service.getActivity(sellerId, {} as any);
      expect(storeModel.find).toHaveBeenCalledWith({ sellerId, isDelete: false });
    });

    it('scopes products (and therefore reviews) strictly to this seller', async () => {
      setup([], ['prod-1']);
      await service.getActivity(sellerId, {} as any);
      expect(productModel.find).toHaveBeenCalledWith({ sellerId });
    });

    it('builds a 4-clause $or: store-scoped activity, seller-action, store-action, moderation-action — never a blind targetId match', async () => {
      setup(['store-a', 'store-b'], ['prod-1'], ['rating-1'], ['report-1', 'report-2']);
      await service.getActivity(sellerId, {} as any);

      const filter = activityLogModel.find.mock.calls[0][0];
      expect(filter.$or).toHaveLength(4);

      // Clause 1 — normal store-scoped activity (test 6).
      expect(filter.$or[0]).toEqual({ storeId: { $in: ['store-a', 'store-b'] } });

      // Clause 2 — seller-level actions, targetId IS the sellerId, constrained
      // to exactly the two verified action names (test 1/2).
      expect(filter.$or[1]).toEqual({
        storeId: 'platform',
        action: { $in: ['seller_suspended', 'seller_unsuspended'] },
        targetId: sellerId,
      });

      // Clause 3 — store-level actions, targetId constrained to THIS seller's
      // own resolved store ids only (test 3/4 + isolation half of test 7).
      expect(filter.$or[2]).toEqual({
        storeId: 'platform',
        action: { $in: ['store_suspended', 'store_unsuspended'] },
        targetId: { $in: ['store-a', 'store-b'] },
      });

      // Clause 4 — moderation actions, targetId constrained to report ids
      // resolved from THIS seller's own reports/listings/reviews only,
      // never a raw sellerId/storeId match (test 5).
      expect(filter.$or[3]).toEqual({
        storeId: 'platform',
        action: { $in: ['report_reviewed', 'report_approved', 'report_removed'] },
        targetId: { $in: ['report-1', 'report-2'] },
      });
    });

    it('never includes buyer_suspended/buyer_unsuspended — a platform-wide buyer ban is not an action about this client', async () => {
      setup(['store-a']);
      await service.getActivity(sellerId, {} as any);
      const filter = activityLogModel.find.mock.calls[0][0];
      const allActionValues = filter.$or.flatMap((clause: any) => clause.action?.$in ?? []);
      expect(allActionValues).not.toContain('buyer_suspended');
      expect(allActionValues).not.toContain('buyer_unsuspended');
    });

    it('resolves report ids from the seller/listing/review chain, not a bare sellerId/storeId match (test 8 — action-name constraint is what filters, not id coincidence)', async () => {
      setup(['store-a'], ['prod-1'], ['rating-1'], ['report-9']);
      await service.getActivity(sellerId, {} as any);

      const reportFilter = reportModel.find.mock.calls[0][0];
      expect(reportFilter).toEqual({
        $or: [
          { targetType: 'seller', targetId: sellerId },
          { targetType: 'listing', targetId: { $in: ['prod-1'] } },
          { targetType: 'review', targetId: { $in: ['rating-1'] } },
        ],
      });

      const filter = activityLogModel.find.mock.calls[0][0];
      expect(filter.$or[3].targetId.$in).toEqual(['report-9']);
    });

    it('two different sellers resolve to disjoint id sets, so one client\'s activity query can never structurally include another\'s (test 7)', async () => {
      setup(['store-for-seller-1']);
      await service.getActivity(sellerId, {} as any);
      const firstCallFilter = activityLogModel.find.mock.calls[0][0];

      setup(['store-for-seller-2']);
      await service.getActivity('507f1f77bcf86cd799439099', {} as any);
      const secondCallFilter = activityLogModel.find.mock.calls[1][0];

      expect(firstCallFilter.$or[0]).toEqual({ storeId: { $in: ['store-for-seller-1'] } });
      expect(secondCallFilter.$or[0]).toEqual({ storeId: { $in: ['store-for-seller-2'] } });
      expect(firstCallFilter.$or[1].targetId).not.toBe(secondCallFilter.$or[1].targetId);
    });
  });

  describe('getModeration', () => {
    const sellerId = '507f1f77bcf86cd799439011';

    it('covers all three report target types for this seller (seller/listing/review), not just direct seller reports', async () => {
      productModel.find.mockReturnValue(findChain([{ _id: 'prod-1' }]));
      ratingModel.find.mockReturnValue(findChain([{ _id: 'rating-1' }]));
      reportModel.find.mockReturnValue({ sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });

      await service.getModeration(sellerId);

      const filter = reportModel.find.mock.calls[0][0];
      expect(filter.$or).toEqual([
        { targetType: 'seller', targetId: sellerId },
        { targetType: 'listing', targetId: { $in: ['prod-1'] } },
        { targetType: 'review', targetId: { $in: ['rating-1'] } },
      ]);
    });
  });
});
