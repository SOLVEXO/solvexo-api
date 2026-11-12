/* eslint-disable prettier/prettier */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '../database/databaseservice';
import { AdminUsersService } from '../admin-users/admin-users.service';
import { AdminAnalyticsService } from '../admin-analytics/admin-analytics.service';
import { AdminFinanceService } from '../admin-finance/admin-finance.service';
import { SellerPlatformSubscriptionsService } from '../platform-plans/seller-platform-subscriptions.service';
import { AdminModerationService } from '../admin-moderation/admin-moderation.service';
import { ClientActivityQueryDto } from './dto/client-activity-query.dto';
import { storeTrustSnapshot } from '../seller-trust/seller-trust.service';

/** Onboarding wizard answers worth showing an admin (the draft holds other UI state too). */
const ONBOARDING_ANSWER_KEYS = ['sellerType', 'productTypes', 'country', 'currency', 'baseCurrency', 'businessType', 'categoryId', 'storeName', 'name', 'platformPlanId', 'planId', 'billingCycle', 'language'];

// The three admin actions (per verified `action` string) whose ActivityLog
// entry logs `storeId: 'platform'` with the real seller/store/report id only
// in `targetId` — see AdminClientsService's own comment on `getActivity`
// for why the Activity query below needs to special-case exactly these,
// and only these, instead of a blind `targetId` match against any platform
// event that happens to share an id.
const SELLER_LEVEL_ACTIONS = ['seller_suspended', 'seller_unsuspended'];
const STORE_LEVEL_ACTIONS = ['store_suspended', 'store_unsuspended'];
const MODERATION_ACTIONS = ['report_reviewed', 'report_approved', 'report_removed'];

/**
 * Composition layer for the admin "Clients" workspace — a client IS a
 * `Seller` document (see the plan's domain-model section; there is no
 * separate Client/Business schema). Every method here either delegates to
 * an already-existing, already `sellerId`-scoped service (Users, Analytics,
 * Finance, platform-plans) or runs a small number of directly-indexed
 * queries of its own (moderation report resolution, activity resolution) —
 * nothing here duplicates business logic that already lives elsewhere.
 */
@Injectable()
export class AdminClientsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminUsersService: AdminUsersService,
    private readonly adminAnalyticsService: AdminAnalyticsService,
    private readonly adminFinanceService: AdminFinanceService,
    private readonly sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService,
    private readonly adminModerationService: AdminModerationService,
  ) {}

  private get r() {
    return this.databaseService.repositories;
  }

  /** Every route below takes a client (seller) id straight from the URL — validated here as a real ObjectId before any query runs, so a missing/malformed id 400s instead of silently falling through to an unscoped query. */
  private assertValidSellerId(sellerId: string) {
    if (!sellerId || !isValidObjectId(sellerId)) {
      throw new BadRequestException('A valid sellerId is required');
    }
  }

  private async resolveStoreIds(sellerId: string): Promise<string[]> {
    const stores = await this.r.storeModel.find({ sellerId, isDelete: false }).select('_id').lean();
    return (stores as any[]).map((s) => String(s._id));
  }

  /**
   * This client's product ids and, from those, the rating ids belonging to
   * their reviews — the two extra hops needed to find `listing`/`review`
   * reports about this seller (a `Report`'s `targetId` is a productId or a
   * ratingId for those two types, never the sellerId directly — only a
   * `targetType:'seller'` report's `targetId` is literally the sellerId).
   * Shared by `getModeration` and `getActivity`, which both need the exact
   * same "which reports belong to this client" resolution.
   */
  private async resolveClientProductAndRatingIds(sellerId: string): Promise<{ productIds: string[]; ratingIds: string[] }> {
    const products = await this.r.productModel.find({ sellerId }).select('_id').lean();
    const productIds = (products as any[]).map((p) => String(p._id));
    const ratings = productIds.length
      ? await this.r.ratingModel.find({ productId: { $in: productIds } }).select('_id').lean()
      : [];
    const ratingIds = (ratings as any[]).map((rt) => String(rt._id));
    return { productIds, ratingIds };
  }

  /** The `$or` a Report query needs to cover all three ways a report can belong to this client. */
  private reportScopeFilter(sellerId: string, productIds: string[], ratingIds: string[]) {
    return {
      $or: [
        { targetType: 'seller', targetId: sellerId },
        { targetType: 'listing', targetId: { $in: productIds } },
        { targetType: 'review', targetId: { $in: ratingIds } },
      ],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Overview tab — composes the already-existing, already-scoped services.
  // ═══════════════════════════════════════════════════════════════════════

  /** Contact + sign-up data and per-store business verification / trust state (admin "Business profile" tab). */
  async getBusinessProfile(sellerId: string, now = new Date()) {
    this.assertValidSellerId(sellerId);
    const seller: any = await this.r.sellerModel.findOne({ _id: sellerId, isDelete: false })
      .select('name email isVerified phone address authProvider createdAt languagePreference status acquisitionSource acquisitionMedium acquisitionCampaign acquisitionLandingPage acquisitionPartnerCode acquisitionCapturedAt onboardingDraft')
      .lean();
    if (!seller) throw new NotFoundException('Seller not found');

    const stores: any[] = await this.r.storeModel.find({ sellerId, isDelete: false }, {
      name: 1, slug: 1, status: 1, country: 1, businessType: 1, categoryId: 1, contactEmail: 1, contactPhone: 1, taxId: 1, taxRegistered: 1,
      verificationStatus: 1, verificationDueAt: 1, riskLevel: 1, riskReasons: 1, payoutHold: 1, createdAt: 1, sellerType: 1, productTypes: 1, baseCurrency: 1,
      'verification.taxId': 1, 'verification.legalBusinessName': 1, 'verification.cnicNumber': 1,
    }).sort({ createdAt: 1 }).lean();
    const categoryIds = [...new Set(stores.map((st) => st.categoryId).filter(Boolean))];
    const categories: any[] = categoryIds.length ? await this.r.categoryModel.find({ _id: { $in: categoryIds } }, { name: 1 }).lean() : [];
    const categoryById = new Map(categories.map((c) => [String(c._id), c.name]));

    // The wizard draft is cleared once the store exists — fall back to what the first store recorded.
    const form = seller.onboardingDraft?.form ?? null;
    let onboardingAnswers: Record<string, unknown> | null = null;
    if (form && typeof form === 'object') {
      onboardingAnswers = Object.fromEntries(ONBOARDING_ANSWER_KEYS.filter((k) => form[k] !== undefined && form[k] !== null && form[k] !== '').map((k) => [k, form[k]]));
    } else if (stores[0]) {
      const first = stores[0];
      onboardingAnswers = { sellerType: first.sellerType ?? null, productTypes: first.productTypes ?? [], country: first.country ?? null, currency: first.baseCurrency ?? null };
    }

    return {
      success: true,
      data: {
        seller: {
          id: String(seller._id),
          name: seller.name ?? null,
          email: seller.email ?? null,
          emailVerified: !!seller.isVerified,
          phone: seller.phone ?? null,
          address: seller.address ?? null,
          authProvider: seller.authProvider ?? null,
          createdAt: seller.createdAt ?? null,
          languagePreference: seller.languagePreference ?? 'en',
          status: seller.status ?? null,
          acquisition: {
            source: seller.acquisitionSource ?? null,
            medium: seller.acquisitionMedium ?? null,
            campaign: seller.acquisitionCampaign ?? null,
            landingPage: seller.acquisitionLandingPage ?? null,
            partnerCode: seller.acquisitionPartnerCode ?? null,
            capturedAt: seller.acquisitionCapturedAt ?? null,
          },
          onboardingAnswers,
        },
        stores: stores.map((st) => {
          const t = storeTrustSnapshot(st, now);
          return {
            storeId: String(st._id),
            name: st.name,
            slug: st.slug,
            status: st.status,
            country: st.country ?? 'PK',
            businessType: st.businessType ?? null,
            categoryName: st.categoryId ? categoryById.get(String(st.categoryId)) ?? null : null,
            contactEmail: st.contactEmail ?? null,
            contactPhone: st.contactPhone ?? null,
            invoiceTaxId: st.taxId ?? null,
            taxRegistered: st.taxRegistered ?? null,
            verificationStatus: t.verificationStatus,
            hasNtn: t.hasNtn,
            ntn: t.ntn,
            legalBusinessName: st.verification?.legalBusinessName ?? null,
            cnicNumber: st.verification?.cnicNumber ?? null,
            riskLevel: t.riskLevel,
            riskReasons: t.riskReasons,
            dueAt: t.dueAt,
            limited: t.limited,
            payoutHold: t.payoutHold,
            createdAt: st.createdAt,
          };
        }),
      },
    };
  }

  async getOverview(sellerId: string) {
    this.assertValidSellerId(sellerId);

    const [sellerDetail, analyticsOverview, financeRollup, billingOverview, openModerationReports] = await Promise.all([
      this.adminUsersService.getById('seller', sellerId),
      this.adminAnalyticsService.getOverview({ sellerId }),
      this.adminFinanceService.getSellerFinancialRollup(sellerId),
      this.sellerPlatformSubscriptionsService.getSellerOverview(sellerId),
      this.countOpenModerationReports(sellerId),
    ]);

    return {
      success: true,
      data: {
        seller: sellerDetail.data,
        analytics: analyticsOverview.data,
        finance: financeRollup.data,
        billing: billingOverview.data,
        openModerationReports,
      },
    };
  }

  private async countOpenModerationReports(sellerId: string): Promise<number> {
    const { productIds, ratingIds } = await this.resolveClientProductAndRatingIds(sellerId);
    return this.r.reportModel.countDocuments({
      status: { $ne: 'resolved' },
      ...this.reportScopeFilter(sellerId, productIds, ratingIds),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Finance tab — thin pass-through to the already-built rollup.
  // ═══════════════════════════════════════════════════════════════════════

  async getFinance(sellerId: string) {
    this.assertValidSellerId(sellerId);
    return this.adminFinanceService.getSellerFinancialRollup(sellerId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Moderation tab — reports against the seller account, their product
  // listings, and reviews on those products, in one composed response.
  // Explicitly not limited to `targetType:'seller'` — see the plan's
  // preflight-review notes on why that would silently hide real issues.
  // ═══════════════════════════════════════════════════════════════════════

  async getModeration(sellerId: string) {
    this.assertValidSellerId(sellerId);
    const { productIds, ratingIds } = await this.resolveClientProductAndRatingIds(sellerId);

    const rawReports = await this.r.reportModel
      .find(this.reportScopeFilter(sellerId, productIds, ratingIds))
      .sort({ createdAt: -1 })
      .lean();

    // Same itemLabel/sellerName join the global Moderation queue already
    // uses (AdminModerationService.enrich, made public for this reuse) —
    // not a second, duplicated resolution.
    const reports = await this.adminModerationService.enrich(rawReports);

    return {
      success: true,
      data: {
        reports,
        // Surfaced so the tab's own UI can disclose scope rather than let a
        // clean list read as "this client has zero moderation history ever".
        scopeNote: 'Reports filed directly against this seller, and against their product listings and reviews.',
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Activity tab — every action across this client's stores, PLUS the
  // platform-scoped admin actions (seller suspend/unsuspend, store
  // suspend/unsuspend, moderation review/approve/remove) that log with
  // `storeId:'platform'` and the real id only in `targetId`. Deliberately
  // NOT a blind `targetId IN [sellerId, ...storeIds]` match — each clause
  // below is constrained to its own exact, verified `action` name(s) so an
  // unrelated platform event can never be pulled in just because its
  // `targetId` happens to equal one of this client's ids. See the plan's
  // preflight section for the verification this was built against.
  // ═══════════════════════════════════════════════════════════════════════

  async getActivity(sellerId: string, query: ClientActivityQueryDto) {
    this.assertValidSellerId(sellerId);

    const [storeIds, { productIds, ratingIds }] = await Promise.all([
      this.resolveStoreIds(sellerId),
      this.resolveClientProductAndRatingIds(sellerId),
    ]);

    const moderationReportIds = (
      await this.r.reportModel
        .find(this.reportScopeFilter(sellerId, productIds, ratingIds))
        .select('_id')
        .lean()
    ).map((rep: any) => String(rep._id));

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Number(query.limit) || 50);
    const skip = (page - 1) * limit;

    const filter: Record<string, any> = {
      $or: [
        { storeId: { $in: storeIds } },
        { storeId: 'platform', action: { $in: SELLER_LEVEL_ACTIONS }, targetId: sellerId },
        { storeId: 'platform', action: { $in: STORE_LEVEL_ACTIONS }, targetId: { $in: storeIds } },
        { storeId: 'platform', action: { $in: MODERATION_ACTIONS }, targetId: { $in: moderationReportIds } },
      ],
    };
    if (query.category) filter.category = query.category;
    if (query.isSecurityAlert !== undefined) filter.isSecurityAlert = query.isSecurityAlert;

    const [total, logs] = await Promise.all([
      this.r.activityLogModel.countDocuments(filter),
      this.r.activityLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    return {
      success: true,
      data: { pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, logs },
    };
  }
}
