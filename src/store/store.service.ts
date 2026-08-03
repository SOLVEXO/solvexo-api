/* eslint-disable prettier/prettier */
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';
import { SellerType, ProductType, resolveTools } from './schemas/store.schema';
import { SUPPORTED_CURRENCIES } from 'src/exchange-rate/schemas/exchange-rate.schema';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { UpdateStoreCustomerDto } from './dto/update-store-customer.dto';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { SellerPlatformSubscriptionsService } from 'src/platform-plans/seller-platform-subscriptions.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NOTIFICATION_TYPES } from 'src/notifications/notification.types';
import { RedisService } from 'src/redis/redis.service';
import { MarketingService } from 'src/marketing/marketing.service';
import { pickPrimaryCampaignForBadge } from 'src/marketing/campaign-pricing.util';
import { AdminConfigService } from 'src/admin-config/admin-config.service';

// Store slugs render at the site root (`solvexo.store/:slug`) — these are the
// frontend's top-level static route segments (router/index.tsx), reserved so
// a store can never claim a URL that collides with a real app page.
const RESERVED_STORE_SLUGS = new Set([
  'pricing', 'sellers', 'faq', 'privacy-policy', 'terms-of-service', 'cookie-policy',
  'contact-us', 'account', 'marketplace', 'cart', 'checkout', 'order-success',
  'educationmarketplace', 'maintenance', 'login', 'register', 'onboard',
  'forgot-password', 'verify-otp', 'new-password', 'seller', 'admin', 'store',
]);

@Injectable()
export class StoreService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    private readonly subscriptionBenefits: SubscriptionBenefitsService,
    private readonly entitlementsService: EntitlementsService,
    private readonly sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService,
    private readonly notificationsService: NotificationsService,
    private readonly redisService: RedisService,
    private readonly marketingService: MarketingService,
    private readonly adminConfigService: AdminConfigService,
  ) {}

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  // A store's category must be one of the admin-curated main categories —
  // not a subcategory, and not an arbitrary/made-up id.
  private async assertValidRootCategory(categoryId: string) {
    const category = await this.databaseService.repositories.categoryModel.findOne({
      _id: categoryId,
      status: 'active',
      isDelete: false,
    });
    if (!category) throw new BadRequestException('Selected category not found');
    if (category.parentId) throw new BadRequestException('Store category must be a main category, not a subcategory');
  }

  async createStore(sellerId: string, body: any) {
    const { name, logo, categoryId, description, sellerType, productTypes, baseCurrency } = body;

    if (!name) throw new BadRequestException('Store name is required');

    // Pricing currency is chosen once, here, and is locked forever the
    // moment this store has its first product (see ProductVariantsService/
    // ProductsService, which stamp every new variant's currency from this
    // field rather than letting it be picked per-product) — this is what
    // prevents a seller's price number from ever being silently
    // reinterpreted under a different currency later. The frontend
    // onboarding flow suggests a default from the seller's detected
    // country, but never forces it — this validation only enforces that
    // whatever was chosen is one of the currencies Solvexo actually
    // supports today.
    if (!baseCurrency || !SUPPORTED_CURRENCIES.includes(baseCurrency)) {
      throw new BadRequestException(
        `baseCurrency is required and must be one of: ${SUPPORTED_CURRENCIES.join(', ')}`,
      );
    }

    if (categoryId) await this.assertValidRootCategory(categoryId);

    if (sellerType && !Object.values(SellerType).includes(sellerType)) {
      throw new BadRequestException('Invalid sellerType');
    }

    if (productTypes && Array.isArray(productTypes)) {
      const validTypes = Object.values(ProductType);
      for (const pt of productTypes) {
        if (!validTypes.includes(pt)) {
          throw new BadRequestException(`Invalid productType: ${pt}`);
        }
      }
    }

    // ✅ multiple stores allowed — koi "already have a store" check nahi

    const baseSlug = this.generateSlug(name);
    let slug = baseSlug;
    let count = 1;

    while (
      RESERVED_STORE_SLUGS.has(slug) ||
      (await this.databaseService.repositories.storeModel.findOne({ slug }))
    ) {
      slug = `${baseSlug}-${count}`;
      count++;
    }

    const finalProductTypes = productTypes ?? [];

    const store = await this.databaseService.repositories.storeModel.create({
      sellerId,
      name,
      slug,
      logo: logo ?? null,
      categoryId: categoryId ?? null,
      description: description ?? null,
      sellerType: sellerType ?? null,
      productTypes: finalProductTypes,
      enabledTools: resolveTools(finalProductTypes),
      baseCurrency,
      // Goes into the admin Leads queue — not live on the marketplace until
      // an admin approves it (see AdminMarketplaceService.approveLead).
      status: 'pending',
    });

    // ✅ seller pe sirf onboarded mark — storeId nahi rakhte (source of truth = Store.sellerId)
    await this.databaseService.repositories.sellerModel.findByIdAndUpdate(sellerId, {
      isOnboarded: true,
    });

    // Every store always has exactly one platform-plan subscription — auto
    // start on the free tier so onboarding has zero friction (see EntitlementsService).
    await this.sellerPlatformSubscriptionsService.ensureDefaultSubscription(store._id.toString(), sellerId);

    return {
      success: true,
      message: 'Store created successfully',
      data: store,
    };
  }

  /** Platform-plan-gated: only stores on a plan with `customDomainAllowed` may set a custom domain. */
  async setCustomDomain(sellerId: string, storeId: string, domain: string | null) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    if (domain) {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'customDomainAllowed', 'Custom domain');
    }

    store.customDomain = domain;
    await store.save();

    this.activityLogService.log({
      storeId, category: 'settings', action: 'custom_domain_updated',
      description: domain ? `Custom domain set to ${domain}` : 'Custom domain removed',
      actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Custom domain updated', data: { customDomain: store.customDomain } };
  }

  /** Platform-plan-gated: only stores on a plan with `whiteLabelAllowed` may hide Solvexo branding. */
  async setWhiteLabel(sellerId: string, storeId: string, enabled: boolean) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    if (enabled) {
      await this.entitlementsService.assertFeatureAllowed(storeId, 'whiteLabelAllowed', 'White-label branding');
    }

    store.whiteLabelEnabled = enabled;
    await store.save();

    return { success: true, message: 'White-label setting updated', data: { whiteLabelEnabled: store.whiteLabelEnabled } };
  }

  async updatePinnedProducts(sellerId: string, storeId: string, productIds: string[]) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const limit = await this.adminConfigService.getPlacementLimit('storeFeaturedProducts');
    store.pinnedProductIds = productIds.slice(0, limit);
    await store.save();

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'pinned_products_updated',
      description: `Pinned products updated (${store.pinnedProductIds.length} product(s))`,
      actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Pinned products updated', data: { pinnedProductIds: store.pinnedProductIds } };
  }

  async updateAnnouncementBar(sellerId: string, storeId: string, body: any) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    store.announcementBar = {
      message: body.message ?? null,
      type: body.type ?? 'info',
      ctaLabel: body.ctaLabel ?? null,
      ctaLink: body.ctaLink ?? null,
      isActive: !!body.isActive,
      startAt: body.startAt ? new Date(body.startAt) : null,
      endAt: body.endAt ? new Date(body.endAt) : null,
    };
    await store.save();

    this.activityLogService.log({
      storeId, category: 'marketing', action: 'announcement_bar_updated',
      description: store.announcementBar.isActive ? 'Store announcement bar activated' : 'Store announcement bar updated',
      actorId: sellerId, actorRole: 'seller',
    });

    return { success: true, message: 'Announcement bar updated', data: store.announcementBar };
  }

  // seller ke saare stores
  async getMyStores(sellerId: string) {
    const { storeModel, sellerModel, productModel, orderModel } =
      this.databaseService.repositories;

    const stores = await storeModel.find({ sellerId, isDelete: false }).lean();

    const seller = await sellerModel.findById(sellerId).select('name email').lean();

    // Products use string storeIds (created via `store._id.toString()`), and
    // sellerOrders.storeId is a string too — match with string ids.
    const storeIds = stores.map((s: any) => s._id.toString());

    // Per-store product counts — one grouped aggregation instead of N counts.
    const productCounts = storeIds.length
      ? await productModel.aggregate([
          { $match: { storeId: { $in: storeIds }, isDelete: false } },
          { $group: { _id: '$storeId', count: { $sum: 1 } } },
        ])
      : [];
    const productCountByStore = new Map<string, number>(
      productCounts.map((r: any) => [r._id, r.count]),
    );

    // Per-store all-time sales — same revenue formula the seller analytics
    // uses (non-cancelled sellerOrders, item totals minus item refunds).
    const salesRows = storeIds.length
      ? await orderModel.aggregate([
          { $match: { isDelete: false } },
          { $unwind: '$sellerOrders' },
          {
            $match: {
              'sellerOrders.storeId': { $in: storeIds },
              'sellerOrders.status': { $ne: 'cancelled' },
            },
          },
          {
            $project: {
              storeId: '$sellerOrders.storeId',
              gross: { $sum: '$sellerOrders.items.totalPrice' },
              refunds: { $sum: '$sellerOrders.items.refundedAmount' },
            },
          },
          {
            $group: {
              _id: '$storeId',
              gross: { $sum: '$gross' },
              refunds: { $sum: '$refunds' },
            },
          },
        ])
      : [];
    const round = (n: number) => Math.round(n * 100) / 100;
    const salesByStore = new Map<string, number>(
      salesRows.map((r: any) => [r._id, round((r.gross ?? 0) - (r.refunds ?? 0))]),
    );

    const data = stores.map((store: any) => {
      const id = store._id.toString();
      return {
        ...store,
        sellerName: seller?.name ?? null,
        sellerEmail: seller?.email ?? null,
        productCount: productCountByStore.get(id) ?? 0,
        totalSalesUSD: salesByStore.get(id) ?? 0,
      };
    });

    // Header strip on the "Your Stores" screen — totals across every store.
    const summary = {
      storeCount: data.length,
      totalProducts: data.reduce((sum, s: any) => sum + s.productCount, 0),
      totalRevenueUSD: round(data.reduce((sum, s: any) => sum + s.totalSalesUSD, 0)),
    };

    return {
      success: true,
      count: data.length,
      summary,
      data,
    };
  }

  async getStoreById(storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    return {
      success: true,
      data: store,
    };
  }

  // ✅ ab storeId se update hota hai (multiple stores ke liye zaroori)
  // `status` is deliberately never read from `body` here — it's a lifecycle
  // field (active/inactive/suspended) that only admin actions or future
  // recovery flows should be able to change. Accepting it from the request
  // body would let a seller un-suspend their own store (see
  // usersService.deleteSellerAccount, which suspends stores on delete).
  async updateStore(sellerId: string, storeId: string, body: any) {
    const { name, logo, coverImage, description, sellerType, productTypes, codEnabled } = body;

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });

    if (!store) throw new NotFoundException('Store not found');

    if (store.sellerId !== sellerId)
      throw new UnauthorizedException('You are not authorized to edit this store');

    if (sellerType && !Object.values(SellerType).includes(sellerType)) {
      throw new BadRequestException('Invalid sellerType');
    }

    if (productTypes && Array.isArray(productTypes)) {
      const validTypes = Object.values(ProductType);
      for (const pt of productTypes) {
        if (!validTypes.includes(pt)) {
          throw new BadRequestException(`Invalid productType: ${pt}`);
        }
      }
    }

    const updateData: any = {};

    if (name && name !== store.name) {
      const baseSlug = this.generateSlug(name);
      let slug = baseSlug;
      let count = 1;
      while (
        RESERVED_STORE_SLUGS.has(slug) ||
        (await this.databaseService.repositories.storeModel.findOne({ slug, _id: { $ne: store._id } }))
      ) {
        slug = `${baseSlug}-${count}`;
        count++;
      }
      updateData.name = name;
      updateData.slug = slug;
    }

    if (logo !== undefined) updateData.logo = logo;
    if (coverImage !== undefined) updateData.coverImage = coverImage;
    if (description !== undefined) updateData.description = description;
    if (sellerType !== undefined) updateData.sellerType = sellerType;
    if (codEnabled !== undefined) updateData.codEnabled = !!codEnabled;

    // productTypes change ho to enabledTools bhi refresh
    if (productTypes !== undefined) {
      updateData.productTypes = productTypes;
      updateData.enabledTools = resolveTools(productTypes);
    }

    if (body.categoryId !== undefined) {
      if (body.categoryId) await this.assertValidRootCategory(body.categoryId);
      updateData.categoryId = body.categoryId;
    }

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      store._id,
      updateData,
      { new: true },
    );

    return {
      success: true,
      message: 'Store updated successfully',
      data: updated,
    };
  }

  // ── 1. Save builder config ────────────────────────────────────────────────
  async saveBuilderConfig(sellerId: string, body: any) {
    const { storeId, builderConfig, coverImage } = body;

    if (!storeId) throw new BadRequestException('storeId is required');
    if (!builderConfig) throw new BadRequestException('builderConfig is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const updateData: any = { builderConfig };
    if (coverImage !== undefined) updateData.coverImage = coverImage;

    const updated = await this.databaseService.repositories.storeModel.findByIdAndUpdate(
      storeId,
      updateData,
      { new: true },
    );

    return { success: true, message: 'Builder config saved', data: updated };
  }

  // ── 2. Get builder config ─────────────────────────────────────────────────
  async getBuilderConfig(sellerId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    return {
      success: true,
      data: {
        builderConfig: store.builderConfig ?? null,
        coverImage: store.coverImage ?? null,
        storeName: store.name,
        description: store.description,
      },
    };
  }

  // ── 3. Public store by slug ───────────────────────────────────────────────
  async getPublicStore(slug: string) {
    if (!slug) throw new BadRequestException('slug is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      slug,
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('Store not found');

    const campaigns = await this.marketingService.getActiveCampaignsForStore(store._id.toString());
    const primaryCampaign = pickPrimaryCampaignForBadge(campaigns);

    const bar = (store as any).announcementBar;
    const now = Date.now();
    const announcementActive = !!bar?.isActive
      && (!bar.startAt || new Date(bar.startAt).getTime() <= now)
      && (!bar.endAt || new Date(bar.endAt).getTime() >= now);

    return {
      success: true,
      data: {
        storeId: store._id,
        sellerId: store.sellerId,
        name: store.name,
        slug: store.slug,
        logo: store.logo,
        coverImage: store.coverImage ?? null,
        description: store.description,
        followersCount: store.followersCount ?? 0,
        averageRating: store.averageRating ?? 0,
        reviewCount: store.reviewCount ?? 0,
        builderConfig: store.builderConfig ?? null,
        // Every product in this storefront is priced in this same currency
        // (locked per store, stamped onto every variant at creation) — the
        // frontend uses this to convert every listed price into the
        // buyer's own chosen display currency.
        baseCurrency: store.baseCurrency ?? 'PKR',
        sellerType: (store as any).sellerType ?? null,
        badges: (store as any).badges ?? [],
        createdAt: (store as any).createdAt,
        announcementBar: announcementActive ? { message: bar.message, type: bar.type, ctaLabel: bar.ctaLabel, ctaLink: bar.ctaLink } : null,
        activeCampaign: primaryCampaign ? {
          campaignId: primaryCampaign.campaignId,
          name: primaryCampaign.name,
          discountType: primaryCampaign.discountType,
          discountValue: primaryCampaign.discountValue,
          currency: primaryCampaign.currency,
          endDate: primaryCampaign.endDate,
        } : null,
      },
    };
  }

  private shapeStoreListItem(
    store: any,
    productCount: number | null = null,
    activeCampaign: ReturnType<typeof pickPrimaryCampaignForBadge> = null,
  ): any {
    return {
      storeId: store._id,
      name: store.name,
      slug: store.slug,
      logo: store.logo ?? null,
      coverImage: store.coverImage ?? null,
      description: store.description ?? null,
      categoryId: store.categoryId ?? null,
      followersCount: store.followersCount ?? 0,
      averageRating: store.averageRating ?? 0,
      reviewCount: store.reviewCount ?? 0,
      sellerType: store.sellerType ?? null,
      badges: store.badges ?? [],
      ...(productCount !== null ? { productCount } : {}),
      activeCampaign: activeCampaign ? {
        campaignId: activeCampaign.campaignId,
        name: activeCampaign.name,
        discountType: activeCampaign.discountType,
        discountValue: activeCampaign.discountValue,
        currency: activeCampaign.currency,
        endDate: activeCampaign.endDate,
      } : null,
    };
  }

  // ── 3b. Public stores — browse / search ───────────────────────────────────
  // Backs both the buyer "Stores" browse screen and `api/search/stores`
  // (SearchService.searchStores delegates straight into this).
  async listPublicStores(query: any) {
    const { storeModel, productModel } = this.databaseService.repositories;

    const page = Math.max(1, parseInt(query.page) || 1);
    const limit = Math.min(50, parseInt(query.limit) || 20);
    const skip = (page - 1) * limit;

    const filter: any = { status: 'active', isDelete: false };
    if (query.categoryId && query.categoryId !== 'all') filter.categoryId = query.categoryId;

    const term = (query.q || '').trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = new RegExp(escaped, 'i');
    }

    const sortMap: Record<string, any> = {
      rating: { averageRating: -1, reviewCount: -1 },
      followers: { followersCount: -1 },
      newest: { createdAt: -1 },
    };
    const sort = sortMap[query.sort] ?? sortMap.followers;

    const total = await storeModel.countDocuments(filter);
    const stores = await storeModel.find(filter).sort(sort).skip(skip).limit(limit).lean();

    const storeIds = stores.map((s: any) => s._id.toString());
    const productCounts = storeIds.length
      ? await productModel.aggregate([
          { $match: { storeId: { $in: storeIds }, isDelete: false } },
          { $group: { _id: '$storeId', count: { $sum: 1 } } },
        ])
      : [];
    const productCountByStore = new Map<string, number>(productCounts.map((r: any) => [r._id, r.count]));
    const campaignsByStore = await this.marketingService.getActiveCampaignsForStores(storeIds);

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        stores: stores.map((s: any) =>
          this.shapeStoreListItem(
            s,
            productCountByStore.get(s._id.toString()) ?? 0,
            pickPrimaryCampaignForBadge(campaignsByStore.get(s._id.toString()) ?? []),
          ),
        ),
      },
    };
  }

  // ── 3c. Top stores — cached for the home-screen row ───────────────────────
  async getTopStores(limit: number) {
    const cacheKey = `top-stores:v2:${limit}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) {
      return { success: true, data: { stores: JSON.parse(cached) } };
    }

    const { storeModel, productModel } = this.databaseService.repositories;
    const stores = await storeModel
      .find({ status: 'active', isDelete: false })
      .sort({ averageRating: -1, followersCount: -1 })
      .limit(limit)
      .lean();

    const storeIds = stores.map((s: any) => s._id.toString());
    const productCounts = storeIds.length
      ? await productModel.aggregate([
          { $match: { storeId: { $in: storeIds }, isDelete: false } },
          { $group: { _id: '$storeId', count: { $sum: 1 } } },
        ])
      : [];
    const productCountByStore = new Map<string, number>(productCounts.map((r: any) => [r._id, r.count]));
    const campaignsByStore = await this.marketingService.getActiveCampaignsForStores(storeIds);

    const shaped = stores.map((s: any) =>
      this.shapeStoreListItem(
        s,
        productCountByStore.get(s._id.toString()) ?? 0,
        pickPrimaryCampaignForBadge(campaignsByStore.get(s._id.toString()) ?? []),
      ),
    );
    await this.redisService.set(cacheKey, JSON.stringify(shaped), 600);

    return { success: true, data: { stores: shaped } };
  }

  // ── 3d. Platform-wide stats — homepage stat strip (real numbers, cached) ──
  async getPlatformStats() {
    const cacheKey = 'platform-stats:v1';
    const cached = await this.redisService.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };

    const { sellerModel, storeModel, userModel, orderModel, ratingModel } = this.databaseService.repositories;

    const [storesCount, sellersCount, buyersCount, gmvAgg, ratingAgg] = await Promise.all([
      storeModel.countDocuments({ isDelete: false, status: 'active' }),
      sellerModel.countDocuments({ isDelete: false, status: 'active' }),
      userModel.countDocuments({ isDelete: false }),
      orderModel.aggregate([
        { $match: { isPaid: true } },
        { $group: { _id: null, total: { $sum: '$totalAmount' } } },
      ]),
      ratingModel.aggregate([
        { $match: { isDelete: false, rating: { $ne: null } } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]),
    ]);

    const data = {
      storesCount,
      sellersCount,
      buyersCount,
      gmv: gmvAgg[0]?.total ?? 0,
      avgRating: ratingAgg[0]?.avg ?? 0,
      ratingCount: ratingAgg[0]?.count ?? 0,
    };

    await this.redisService.set(cacheKey, JSON.stringify(data), 600);
    return { success: true, data };
  }

  // ── 3e. Testimonials — real, well-written reviews for the homepage social-proof
  // section. Anonymous reviews stay anonymous; only reviews with real comment text
  // qualify (a bare star rating with no words makes a poor testimonial). ──
  async getTestimonials(limit: number) {
    const cacheKey = `platform-testimonials:${limit}`;
    const cached = await this.redisService.get(cacheKey);
    if (cached) return { success: true, data: JSON.parse(cached) };

    const { ratingModel, userModel, storeModel } = this.databaseService.repositories;

    const candidates = await ratingModel
      .find({
        isDelete: false,
        isFlagged: false,
        rating: { $gte: 4 },
        'comments.0': { $exists: true },
      })
      .sort({ rating: -1, isVerifiedPurchase: -1, createdAt: -1 })
      .limit(limit * 3) // over-fetch — some will drop after the length filter below
      .lean();

    const withText = candidates
      .map((r: any) => ({ ...r, text: r.comments?.[r.comments.length - 1]?.text?.trim() ?? '' }))
      .filter((r: any) => r.text.length >= 25)
      .slice(0, limit);

    const userIds  = [...new Set(withText.map((r: any) => r.userId))];
    const storeIds = [...new Set(withText.map((r: any) => r.storeId).filter(Boolean))];

    const [users, stores] = await Promise.all([
      userIds.length ? userModel.find({ _id: { $in: userIds } }).select('name').lean() : [],
      storeIds.length ? storeModel.find({ _id: { $in: storeIds } }).select('name').lean() : [],
    ]);
    const userNameById  = new Map<string, string>(users.map((u: any): [string, string] => [u._id.toString(), u.name]));
    const storeNameById = new Map<string, string>(stores.map((s: any): [string, string] => [s._id.toString(), s.name]));

    const data = withText.map((r: any) => ({
      id: r._id.toString(),
      name: r.isAnonymous ? 'Verified Buyer' : (userNameById.get(r.userId) ?? 'Verified Buyer'),
      storeName: r.storeId ? (storeNameById.get(r.storeId) ?? null) : null,
      rating: r.rating,
      text: r.text,
      isVerifiedPurchase: r.isVerifiedPurchase,
    }));

    await this.redisService.set(cacheKey, JSON.stringify(data), 600);
    return { success: true, data };
  }

  // ── 4. Public store products ──────────────────────────────────────────────
  async getPublicStoreProducts(storeId: string, query: any, customerId?: string | null) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
      status: 'active',
    }).lean();
    if (!store) throw new NotFoundException('Store not found');

    const page  = parseInt(query.page)  || 1;
    const limit = parseInt(query.limit) || 12;
    const skip  = (page - 1) * limit;

    const filter: any = { storeId, isDelete: false, status: 'active' };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.categoryId && query.categoryId !== 'all') filter.categoryId = query.categoryId;
    if (query.tag && query.tag !== 'all') filter.tags = query.tag;

    const sortMap: Record<string, any> = {
      newest:     { createdAt: -1 },
      price_asc:  { 'variants.price': 1 },
      price_desc: { 'variants.price': -1 },
      best_rated: { averageRating: -1 },
      default:    { createdAt: -1 },
    };
    const sort = sortMap[query.sort] ?? sortMap['default'];

    const total    = await this.databaseService.repositories.productModel.countDocuments(filter);
    const products = await this.databaseService.repositories.productModel
      .find(filter)
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();

    // Cheapest active variant per product — powers the card price and, when
    // the buyer has an active subscription to this store, the member price.
    const productIds = products.map((p: any) => p._id.toString());
    const variants = await this.databaseService.repositories.productVariantModel.find({
      productId: { $in: productIds }, status: 'active', isDelete: false,
    }).sort({ price: 1 }).lean();
    const cheapestByProduct = new Map<string, any>();
    for (const v of variants) {
      if (!cheapestByProduct.has(v.productId)) cheapestByProduct.set(v.productId, v);
    }

    const benefits = await this.subscriptionBenefits.getActiveBenefits(customerId, storeId);

    // Every product on this page belongs to the same store, so this is one
    // lookup for the whole page, not per-product — same active-campaign
    // resolution checkout pricing uses.
    const storeCampaigns = await this.marketingService.getActiveCampaignsForStore(storeId);
    const primaryCampaign = pickPrimaryCampaignForBadge(storeCampaigns);
    const activeCampaignBadge = primaryCampaign ? {
      campaignId: primaryCampaign.campaignId,
      name: primaryCampaign.name,
      discountType: primaryCampaign.discountType,
      discountValue: primaryCampaign.discountValue,
      currency: primaryCampaign.currency,
      endDate: primaryCampaign.endDate,
    } : null;

    const enrichedProducts = products.map((p: any) => {
      const variant = cheapestByProduct.get(p._id.toString());
      const base: any = {
        ...p,
        defaultVariantPrice: variant?.price ?? null,
        variantId:           variant?._id ?? null,
        stock:               variant?.stock ?? null,
        compareAtPrice:      variant?.compareAtPrice ?? null,
        activeCampaign:      activeCampaignBadge,
      };
      if (variant && benefits) {
        const discount = this.subscriptionBenefits.resolveProductDiscount(benefits.benefits, p, variant.price);
        if (discount) {
          base.subscriberPrice = discount.subscriberPrice;
          base.youSaveUSD = discount.savingsUSD;
          base.discountPercent = discount.discountPercent;
          base.subscriberPlanName = benefits.planName;
        }
      }
      return base;
    });

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        products: enrichedProducts,
      },
    };
  }

  // ── 5. Public store filters (tags) ───────────────────────────────────────
  async getPublicStoreFilters(storeId: string) {
    const productModel = this.databaseService.repositories.productModel;
    const tags: string[] = await productModel.distinct('tags', {
      storeId,
      isDelete: false,
      status: 'active',
    });
    return {
      success: true,
      data: { tags: tags.filter(Boolean).sort() },
    };
  }

  // ── 6. Follow / Unfollow store ────────────────────────────────────────────
  async followStore(userId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    });
    if (!store) throw new NotFoundException('Store not found');

    const existing = await this.databaseService.repositories.storeFollowerModel.findOne({
      userId,
      storeId,
    });

    if (existing) {
      await this.databaseService.repositories.storeFollowerModel.deleteOne({ userId, storeId });
      await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
        $inc: { followersCount: -1 },
      });
      return { success: true, message: 'Unfollowed', data: { following: false } };
    }

    await this.databaseService.repositories.storeFollowerModel.create({ userId, storeId });
    await this.databaseService.repositories.storeModel.findByIdAndUpdate(storeId, {
      $inc: { followersCount: 1 },
    });

    this.notificationsService.notify({
      recipientId: store.sellerId,
      recipientRole: 'seller',
      type: NOTIFICATION_TYPES.NEW_FOLLOWER,
      title: 'New follower',
      body: `Someone just started following ${store.name}.`,
      data: { storeId },
    }).catch(() => {});

    return { success: true, message: 'Following', data: { following: true } };
  }

  // ── 7. Get store followers (seller only) ─────────────────────────────────
  async getStoreFollowers(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await this.databaseService.repositories.storeModel.findOne({
      _id: storeId,
      isDelete: false,
    }).lean();
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('Unauthorized');

    const page  = parseInt(query.page)  || 1;
    const limit = parseInt(query.limit) || 20;
    const skip  = (page - 1) * limit;

    const total = await this.databaseService.repositories.storeFollowerModel
      .countDocuments({ storeId });

    const followers = await this.databaseService.repositories.storeFollowerModel
      .find({ storeId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const userIds = followers.map((f) => f.userId);
    const users = await this.databaseService.repositories.userModel
      .find({ _id: { $in: userIds } })
      .select('name email profileImage')
      .lean();

    const userMap: Record<string, any> = {};
    users.forEach((u: any) => { userMap[u._id.toString()] = u; });

    const data = followers.map((f) => ({
      followedAt: (f as any).createdAt,
      user: userMap[f.userId] ?? { _id: f.userId, name: 'Unknown' },
    }));

    return {
      success: true,
      data: {
        total,
        pagination: { page, limit, totalPages: Math.ceil(total / limit) },
        followers: data,
      },
    };
  }

  // ── 6. Get follow status ──────────────────────────────────────────────────
  async getFollowStatus(userId: string, storeId: string) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const existing = await this.databaseService.repositories.storeFollowerModel.findOne({
      userId,
      storeId,
    }).lean();

    return {
      success: true,
      data: { following: !!existing },
    };
  }

  // ── 7. Store customers (staff-facing: only people who have ordered from this store) ────

  async getStoreCustomers(sellerId: string, storeId: string, query: any) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to view this store\'s customers');

    const { orderModel, userModel } = this.databaseService.repositories;

    const page = parseInt(query.page) || 1;
    const limit = parseInt(query.limit) || 20;
    const skip = (page - 1) * limit;

    const customerIds = await orderModel.distinct('userId', { 'sellerOrders.storeId': storeId, isDelete: false });
    const total = customerIds.length;

    const matchStage = { $match: { userId: { $in: customerIds }, isDelete: false, 'sellerOrders.storeId': storeId } };
    const unwindStages = [
      matchStage,
      { $unwind: '$sellerOrders' },
      { $match: { 'sellerOrders.storeId': storeId } },
    ];

    const [stats, [totals]] = await Promise.all([
      orderModel.aggregate([
        ...unwindStages,
        {
          $group: {
            _id: '$userId',
            orderCount: { $sum: 1 },
            totalSpent: { $sum: '$sellerOrders.subtotal' },
            lastOrderAt: { $max: '$createdAt' },
          },
        },
        { $sort: { lastOrderAt: -1 } },
        { $skip: skip },
        { $limit: limit },
      ]),
      orderModel.aggregate([
        ...unwindStages,
        { $group: { _id: null, totalOrders: { $sum: 1 }, totalRevenue: { $sum: '$sellerOrders.subtotal' } } },
      ]),
    ]);

    const pageIds = stats.map((s) => s._id);
    const users = await userModel.find({ _id: { $in: pageIds } }).select('name email phone createdAt').lean() as unknown as
      { _id: unknown; name: string; email: string; phone: string; createdAt: Date }[];
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const customers = stats.map((s) => {
      const u = userMap.get(String(s._id));
      return {
        _id: s._id,
        name: u?.name ?? 'Unknown',
        email: u?.email ?? '',
        phone: u?.phone ?? '',
        createdAt: u?.createdAt ?? null,
        orderCount: s.orderCount,
        totalSpent: s.totalSpent,
        lastOrderAt: s.lastOrderAt,
      };
    });

    return {
      success: true,
      data: {
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        summary: { totalOrders: totals?.totalOrders ?? 0, totalRevenue: totals?.totalRevenue ?? 0 },
        customers,
      },
    };
  }

  async updateStoreCustomer(
    sellerId: string,
    storeId: string,
    customerId: string,
    dto: UpdateStoreCustomerDto,
    ip?: string,
    userAgent?: string,
  ) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');
    if (store.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to edit this store\'s customers');

    const { orderModel, userModel } = this.databaseService.repositories;

    const hasOrderedHere = await orderModel.exists({ userId: customerId, 'sellerOrders.storeId': storeId, isDelete: false });
    if (!hasOrderedHere) throw new BadRequestException('This customer has no orders with your store');

    const update: any = {};
    if (dto.name !== undefined) update.name = dto.name;
    if (dto.phone !== undefined) update.phone = dto.phone;
    if (dto.email !== undefined) {
      update.email = dto.email;
      update.isVerified = false; // new email hasn't gone through OTP yet
    }

    if (Object.keys(update).length === 0) throw new BadRequestException('Nothing to update');

    const customer = await userModel
      .findByIdAndUpdate(customerId, update, { new: true, runValidators: true })
      .select('-password -otp -otpExpiresAt');

    if (!customer) throw new NotFoundException('Customer not found');

    this.activityLogService.log({
      storeId,
      category: 'customers',
      action: 'customer_profile_updated',
      description: `${(customer as any).name} — updated ${Object.keys(update).filter((k) => k !== 'isVerified').join(', ')}`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: customerId,
      targetType: 'customer',
      ip,
      userAgent,
    });

    return { success: true, message: 'Customer updated', data: customer };
  }
}