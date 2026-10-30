import { normalizeDigital } from './digital-input.util';

const pickNewFile = (b: any) => ({ url: b?.url, name: b?.name, size: b?.size, mimeType: b?.mimeType });
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { translatedHandleClause } from '../common/translated-handle.util';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection, Types, isValidObjectId } from 'mongoose';
import {
  PRODUCT_LIMITS, assertMoney, assertStockQuantity, copySku, findDuplicateSku, generateSkus, normalizeBarcode, normalizeDescription,
  normalizeImages, normalizeName, normalizeSku, normalizeStatus, normalizeTags, resolveScheduledAt, normalizeVideoUrl } from './product-input.util';
import { softDeleteProducts } from './product-cascade.util';
import { normalizeComplementaryIds } from './complementary-products.util';
import { buildStoreProductFilter, productSort } from './product-list-filter.util';

import { DatabaseService } from '@/database/databaseservice';
import { ProductType as StoreProductType } from '@/store/schemas/store.schema';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { MarketingService } from '@/marketing/marketing.service';
import { pickPrimaryCampaignForBadge } from '@/marketing/campaign-pricing.util';
import { EducationLevel } from './schemas/product.schema';
import { toCsv } from '@/analytics/utils/csv.util';
import { importProductsCsv as importProductsCsvRows } from './product-bulk-import';
import { EducationLevelService } from './education-level.service';
import { UploadService } from '@/upload/upload.service';
import { generateUniqueSlug } from '@/common/slug.util';
import { RedisService } from '@/redis/redis.service';
import { aggregateProductSales } from '@/analytics/utils/order-aggregation.util';
import {
  PREVIEW_RATE_LIMIT_MAX,
  PREVIEW_RATE_LIMIT_WINDOW_SECONDS,
} from './constants/preview.constants';
import { optionNameSet, optionsKey, validateOptions } from './variant-options.util';
import { toDimensionCm } from '@/shipping-rates/shipping-math.util';
import { parseCustomsInput } from '@/shipping-rates/customs.util';
import { parseSellingOptions } from './selling-options.util';

const EDUCATION_LEVEL_VALUES: string[] = Object.values(EducationLevel);
/** Shopify allows 2000 variants per product; a store builder UI is unusable far earlier, so keep a sane ceiling. */
const MAX_VARIANTS_PER_PRODUCT = 250;

@Injectable()
export class ProductsService {
  constructor(
    private databaseService: DatabaseService,
    private activityLogService: ActivityLogService,
    private entitlementsService: EntitlementsService,
    private educationLevelService: EducationLevelService,
    private marketingService: MarketingService,
    private uploadService: UploadService,
    private redisService: RedisService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** Attaches an `activeCampaign` badge summary (or null) to each product,
   *  based on whether its store currently has an active platform-sale
   *  campaign. Same lookup CheckoutService uses to enforce the discount, so
   *  a product never shows a "sale" badge checkout wouldn't actually honor.
   *  One batched query for the whole page, not per-product. */
  private async attachCampaignBadges<T extends { storeId?: string }>(
    products: T[],
  ): Promise<T[]> {
    const storeIds = [
      ...new Set(products.map((p) => p.storeId).filter(Boolean)),
    ] as string[];
    const campaignsByStore = storeIds.length
      ? await this.marketingService.getActiveCampaignsForStores(storeIds)
      : new Map();

    return products.map((p) => {
      const campaigns = p.storeId ? campaignsByStore.get(p.storeId) : undefined;
      const primary = campaigns ? pickPrimaryCampaignForBadge(campaigns) : null;
      return {
        ...p,
        activeCampaign: primary
          ? {
              campaignId: primary.campaignId,
              name: primary.name,
              discountType: primary.discountType,
              discountValue: primary.discountValue,
              currency: primary.currency,
              endDate: primary.endDate,
            }
          : null,
      };
    });
  }

  // Strips the private Cloudinary file manifest (publicId/name/size/mimeType)
  // from a digital product's `digital.files` before it's shown to a
  // non-owner — pre-purchase browsers only need to know *how many* files
  // they'll get, never the storage manifest itself. The actual bytes are
  // only ever reachable through OrdersService's signed download flow after
  // payment, regardless of this — but the manifest shouldn't leak either.
  private sanitizeDigitalForPublicView<T extends { digital?: any }>(
    product: T,
  ): T {
    if (!product?.digital) return product;
    const { files, preview, ...safeDigital } = product.digital;
    return {
      ...product,
      digital: {
        ...safeDigital,
        fileCount: Array.isArray(files) ? files.length : 0,
        previewAvailable: !!preview?.enabled,
      },
    };
  }

  /**
   * Called from addDigitalProduct/editProduct whenever a seller's `digital`
   * payload is saved. If preview is enabled, resolves the chosen source file
   * and — for pdf/audio only, since those are stored under Cloudinary
   * resource_type 'raw' and can't be transformed in place — lazily prepares a
   * transform-capable shadow copy via UploadService.ensurePreviewSourceAsset.
   * `existingPreview` is the product's current `digital.preview` (or null for
   * a brand-new product) so we can skip re-preparing an unchanged source file.
   */
  private async prepareDigitalPreview(
    existingPreview: any,
    digital: any,
  ): Promise<any> {
    if (!digital?.preview?.enabled) {
      return {
        ...digital,
        preview: {
          enabled: false,
          sourceFileIndex: null,
          previewSourcePublicId: null,
          previewSourceResourceType: null,
        },
      };
    }

    const sourceFileIndex = digital.preview.sourceFileIndex ?? 0;
    const file = digital.files?.[sourceFileIndex];
    if (!file)
      throw new BadRequestException(
        'preview.sourceFileIndex does not match any uploaded file',
      );

    const mimeType =
      file.mimeType || this.uploadService.resolveMimeType(file.name, '');
    const unchanged =
      existingPreview?.enabled &&
      existingPreview?.sourceFileIndex === sourceFileIndex &&
      existingPreview?.previewSourcePublicId;

    let previewSourcePublicId: string | null = unchanged
      ? existingPreview.previewSourcePublicId
      : null;
    let previewSourceResourceType: 'image' | 'video' | null = unchanged
      ? existingPreview.previewSourceResourceType
      : null;

    if (!unchanged) {
      if (mimeType === 'application/pdf') {
        previewSourcePublicId =
          await this.uploadService.ensurePreviewSourceAsset(
            file.url,
            'raw',
            'image',
          );
        previewSourceResourceType = 'image';
      } else if (mimeType.startsWith('audio/')) {
        previewSourcePublicId =
          await this.uploadService.ensurePreviewSourceAsset(
            file.url,
            'raw',
            'video',
          );
        previewSourceResourceType = 'video';
      } else if (
        mimeType.startsWith('image/') ||
        mimeType.startsWith('video/')
      ) {
        previewSourcePublicId = null; // already transform-capable in place
        previewSourceResourceType = null;
      } else {
        throw new BadRequestException(
          `Preview is not supported for file type "${mimeType}"`,
        );
      }
    }

    return {
      ...digital,
      preview: {
        enabled: true,
        sourceFileIndex,
        previewSourcePublicId,
        previewSourceResourceType,
      },
    };
  }

  /** Public, pre-purchase preview of a digital product — always a watermarked/trimmed derivative, never the original file. */
  async getProductPreview(idOrSlug: string, clientIp: string, storeId?: string) {
    const rateLimitKey = `preview:rl:${clientIp}:${idOrSlug}`;
    const count = await this.redisService.incrWithTtl(
      rateLimitKey,
      PREVIEW_RATE_LIMIT_WINDOW_SECONDS,
    );
    if (count !== null && count > PREVIEW_RATE_LIMIT_MAX) {
      throw new HttpException(
        {
          success: false,
          message: 'Too many preview requests — please try again later',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const { productModel } = this.databaseService.repositories;
    // Same slug-first, id-fallback resolution as getProductById — the
    // product-detail page passes whatever :slug route param it has.
    let product = await productModel
      .findOne({ slug: idOrSlug, status: 'active', isDelete: false })
      .lean();
    if (!product && isValidObjectId(idOrSlug)) {
      product = await productModel
        .findOne({ _id: idOrSlug, status: 'active', isDelete: false })
        .lean();
    }
    if (!product) throw new NotFoundException('Product not found');
    if (storeId && product.storeId && product.storeId !== storeId) {
      throw new NotFoundException('Product not found');
    }
    if (product.type !== 'digital' || !product.digital?.preview?.enabled) {
      throw new BadRequestException(
        'Preview is not available for this product',
      );
    }

    const sourceFileIndex = product.digital.preview.sourceFileIndex ?? 0;
    const file = product.digital.files?.[sourceFileIndex];
    if (!file) throw new BadRequestException('Preview source file not found');

    const mimeType =
      file.mimeType || this.uploadService.resolveMimeType(file.name, '');
    const expiresAt = Math.floor(Date.now() / 1000) + 300;

    if (mimeType === 'application/pdf') {
      if (!product.digital.preview.previewSourcePublicId)
        throw new BadRequestException(
          'Preview is not ready for this product yet',
        );
      const pages = this.uploadService.generatePreviewPdfPageUrls(
        product.digital.preview.previewSourcePublicId,
      );
      return { success: true, data: { type: 'pdf', pages, expiresAt } };
    }
    if (mimeType.startsWith('image/')) {
      return {
        success: true,
        data: {
          type: 'image',
          url: this.uploadService.generatePreviewImageUrl(file.url),
          expiresAt,
        },
      };
    }
    if (mimeType.startsWith('video/')) {
      return {
        success: true,
        data: {
          type: 'video',
          url: this.uploadService.generatePreviewVideoUrl(file.url),
          expiresAt,
        },
      };
    }
    if (mimeType.startsWith('audio/')) {
      if (!product.digital.preview.previewSourcePublicId)
        throw new BadRequestException(
          'Preview is not ready for this product yet',
        );
      return {
        success: true,
        data: {
          type: 'audio',
          url: this.uploadService.generatePreviewAudioUrl(
            product.digital.preview.previewSourcePublicId,
          ),
          expiresAt,
        },
      };
    }
    throw new BadRequestException(
      'Preview is not supported for this file type',
    );
  }

  /** Constrains a product query to only stores with `status: 'active'` —
   *  `Product.status` alone isn't enough: a store can be suspended/rejected
   *  by an admin action *after* its products were created and left
   *  `status: 'active'` on the product itself, so public browse/search must
   *  independently re-check the owning store on every request rather than
   *  relying on product-creation-time gating alone. Intersects with any
   *  `storeId.$in` the query already has (e.g. a campaign's participating
   *  stores) instead of overwriting it. */
  private async restrictToActiveStores(query: any, excludeLocked = true): Promise<void> {
    // Marketplace-wide listings (no single storeId) also drop password-protected / coming_soon stores so a locked store never
    // leaks via search/category browse. A single exact storeId is left to the storefront-access middleware (owner/token bypass).
    const wide = excludeLocked && typeof query.storeId !== 'string';
    const activeIds: string[] = (
      await this.databaseService.repositories.storeModel
        .find({ status: 'active', isDelete: false, ...(wide ? { privacyMode: { $nin: ['password', 'coming_soon'] } } : {}) }, { _id: 1 })
        .lean()
    ).map((s: any) => s._id.toString());

    query.storeId = this.narrowStoreIdConstraint(query.storeId, activeIds);
  }

  /** Narrows an existing `storeId` query constraint (none | a single exact id |
   *  `{ $in: [...] }`) down to only the ids also present in `candidateIds`,
   *  without ever widening it. Used to layer independent storeId restrictions
   *  (a single-store app's own storeId, a campaign's participating stores,
   *  the active-stores gate) on top of each other safely — e.g. a caller that
   *  already scoped `query.storeId` to its own store keeps exactly that store
   *  (or nothing, if that store isn't itself in `candidateIds`), rather than
   *  having a later gate silently widen it back out to every candidate. */
  private narrowStoreIdConstraint(current: any, candidateIds: string[]): any {
    const candidates = new Set(candidateIds.map(String));
    if (current == null) {
      return { $in: Array.from(candidates) };
    }
    if (typeof current === 'string') {
      return candidates.has(current) ? current : { $in: [] };
    }
    if (current.$in) {
      return { $in: (current.$in as string[]).filter((id) => candidates.has(String(id))) };
    }
    return { $in: [] };
  }

  async getProductsByCategoryId(
    parentCategoryId?: string,
    page: number = 1,
    limit: number = 10,
    customerId?: string | null,
    productType?: string,
    educationLevel?: string,
    normalizedCustomLevel?: string,
    campaignId?: string,
    minPrice?: number,
    maxPrice?: number,
    minRating?: number,
    sortBy?: 'newest' | 'price_asc' | 'price_desc' | 'rating' | 'popularity',
    storeId?: string,
  ): Promise<any> {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    const query: any = {
      status: 'active',
      isDelete: false,
    };

    // A single-store app build passes its own storeId so category browsing
    // never surfaces another store's products — narrowed further below by
    // any campaign restriction and the active-stores gate, never widened.
    if (storeId) query.storeId = storeId;

    // 0️⃣ Optional productType/educationLevel filters — used by verticals like the
    // Education marketplace to show only `productType: 'educational'` listings
    // from the same shared catalog, instead of a separate one. normalizedCustomLevel
    // is the Tier-2 drill-down, only meaningful when educationLevel === 'other'.
    if (productType) query.productType = productType;
    if (educationLevel) query.educationLevel = educationLevel;
    if (normalizedCustomLevel)
      query.normalizedCustomLevel = normalizedCustomLevel;

    // "Shop the Sale" — an expired/unknown/inactive/malformed campaignId (e.g. a
    // stale bookmark to a sale that's since ended) yields an intentionally
    // empty result, not an error: it should read as "nothing left on sale",
    // not a 404/500.
    if (campaignId) {
      const campaignModel = this.databaseService.repositories.campaignModel;
      const campaignBaseFilter = {
        isDelete: false,
        status: 'active',
        startDate: { $lte: new Date() },
        endDate: { $gte: new Date() },
      };
      // campaignId may be the new slug-based handle (?campaign=summer-sale)
      // or an old bookmarked raw id — try slug first, then id, same
      // resolution order as ProductsService.getProductById.
      let campaign = await campaignModel
        .findOne({ slug: campaignId, ...campaignBaseFilter })
        .select('participatingStoreIds sponsorType')
        .lean();
      if (!campaign && isValidObjectId(campaignId)) {
        campaign = await campaignModel
          .findOne({ _id: campaignId, ...campaignBaseFilter })
          .select('participatingStoreIds sponsorType')
          .lean();
      }
      // A platform-sponsored campaign applies to every store — no storeId
      // restriction at all, same universal rule as getActiveCampaignsForStores.
      if (campaign && campaign.sponsorType !== 'platform') {
        query.storeId = this.narrowStoreIdConstraint(query.storeId, campaign.participatingStoreIds ?? []);
      } else if (!campaign) {
        query.storeId = { $in: [] };
      }
    }

    // 1️⃣ Agar category ID di gayi hai to filter lagao
    //
    // A `Product` stores its category as two separate flat fields, not a
    // nested chain: `categoryId` (always the seller's store's main category)
    // and an optional `subCategoryId`. Categories are also capped at exactly
    // 2 levels (main → sub, enforced in CategoriesService), so there's no
    // deeper tree to walk here.
    //
    // So: browsing a MAIN category means "any product under it, with or
    // without a subcategory" → filter by `categoryId`. Browsing a
    // SUBCATEGORY means "only products tagged with this specific
    // subcategory" → filter by `subCategoryId`.
    if (parentCategoryId) {
      const category =
        await this.databaseService.repositories.categoryModel.findOne({
          _id: parentCategoryId,
          status: 'active',
          isDelete: false,
        });

      if (category?.parentId) {
        query.subCategoryId = parentCategoryId;
      } else {
        query.categoryId = parentCategoryId;
      }
    }

    await this.restrictToActiveStores(query);

    // Rating lives directly on `Product`, so it's a plain query clause —
    // unlike price (see below), it never needs the variants aggregation.
    if (minRating !== undefined) {
      query.averageRating = { $gte: minRating };
    }

    const skip = (page - 1) * limit;

    // Price lives on `ProductVariant`, not `Product` (a product can have many
    // variants at different prices), so filtering/sorting by "price" — the
    // same cheapest-variant price shown to buyers as the "starting from"
    // price — requires a `$lookup` into variants rather than a plain
    // `find()`. Only pay for that join when price is actually in play;
    // every other browse (the overwhelming majority) keeps the cheap path.
    const needsPriceAggregation =
      minPrice !== undefined ||
      maxPrice !== undefined ||
      sortBy === 'price_asc' ||
      sortBy === 'price_desc';

    let total: number;
    let products: any[];

    if (needsPriceAggregation) {
      const priceRange: any = {};
      if (minPrice !== undefined) priceRange.$gte = minPrice;
      if (maxPrice !== undefined) priceRange.$lte = maxPrice;

      const pipeline: any[] = [
        { $match: query },
        {
          // `ProductVariant.productId` is stored as a plain string (not an
          // ObjectId ref), so the join needs `$toString` on the product side.
          $lookup: {
            from: productVariantModel.collection.name,
            let: { pid: { $toString: '$_id' } },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$productId', '$$pid'] },
                  status: 'active',
                  isDelete: false,
                },
              },
              { $project: { price: 1 } },
            ],
            as: '_variantsForFilter',
          },
        },
        { $addFields: { _minVariantPrice: { $min: '$_variantsForFilter.price' } } },
      ];

      if (Object.keys(priceRange).length) {
        // A product with no active variants has no price at all — exclude
        // it whenever a price filter is actually active rather than letting
        // it slip through as a false match.
        pipeline.push({ $match: { _minVariantPrice: { $ne: null, ...priceRange } } });
      }

      const sortStage =
        sortBy === 'price_asc'
          ? { _minVariantPrice: 1, _id: -1 }
          : sortBy === 'price_desc'
            ? { _minVariantPrice: -1, _id: -1 }
            : sortBy === 'rating'
              ? { averageRating: -1, _id: -1 }
              : sortBy === 'popularity'
                ? { purchaseCount: -1, _id: -1 }
                : { createdAt: -1, _id: -1 };

      pipeline.push({
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [
            { $sort: sortStage },
            { $skip: skip },
            { $limit: limit },
            { $project: { _variantsForFilter: 0, _minVariantPrice: 0 } },
          ],
        },
      });

      const [result] = await productModel.aggregate(pipeline);
      total = result?.metadata?.[0]?.total ?? 0;
      products = result?.data ?? [];
    } else {
      const sortStage =
        sortBy === 'rating'
          ? { averageRating: -1, _id: -1 }
          : sortBy === 'popularity'
            ? { purchaseCount: -1, _id: -1 }
            : { createdAt: -1, _id: -1 };

      total = await productModel.countDocuments(query);
      products = await productModel
        .find(query)
        .sort(sortStage as any)
        .skip(skip)
        .limit(limit)
        .lean();
    }

    const productIds = products.map((p) => p._id.toString());

    // 2️⃣ Variants fetch
    const variants = await productVariantModel
      .find({
        productId: { $in: productIds },
        status: 'active',
        isDelete: false,
      })
      .lean();

    const variantMap: Record<string, any[]> = {};

    for (const v of variants) {
      if (!variantMap[v.productId]) {
        variantMap[v.productId] = [];
      }
      variantMap[v.productId].push(v);
    }

    // Batch-resolve seller name + verification badge across every distinct
    // seller present in this page — one query instead of N.
    const sellerIds = [
      ...new Set(products.map((p) => p.sellerId).filter(Boolean)),
    ];
    const sellers = await sellerModel
      .find({ _id: { $in: sellerIds } })
      .select('name isVerified')
      .lean();
    const sellerMap = new Map(
      sellers.map((s) => [s._id.toString(), s]),
    );

    const productsWithVariants = await this.attachCampaignBadges(
      products.map((p) => {
        const seller = sellerMap.get(p.sellerId?.toString());
        return this.sanitizeDigitalForPublicView({
          ...p,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          variants: variantMap[p._id.toString()] || [],
        });
      }),
    );

    return {
      message: 'Products fetched successfully',
      success: true,
      data: {
        total,
        page,
        limit,
        products: productsWithVariants,
      },
    };
  }

  /** Variants + subscriber pricing for a page of lean product docs — the same
   *  shaping `getProductsByCategoryId` does, reusable for search/recently-viewed. */
  private async attachVariantsAndPricing(
    products: any[],
    customerId?: string | null,
  ) {
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    const productIds = products.map((p) => p._id.toString());
    const variants = await productVariantModel
      .find({
        productId: { $in: productIds },
        status: 'active',
        isDelete: false,
      })
      .lean();

    const variantMap: Record<string, any[]> = {};
    for (const v of variants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    // Batch-resolve seller name + verification badge across every distinct
    // seller present in this batch — same one-query-instead-of-N pattern as
    // getProductsByCategoryId, so search results and getShapedProductsByIds
    // (recently-viewed, recent searches) carry the same badge.
    const sellerIds = [
      ...new Set(products.map((p) => p.sellerId).filter(Boolean)),
    ];
    const sellers = await sellerModel
      .find({ _id: { $in: sellerIds } })
      .select('name isVerified')
      .lean();
    const sellerMap = new Map(sellers.map((s) => [s._id.toString(), s]));

    return this.attachCampaignBadges(
      products.map((p) => {
        const seller = sellerMap.get(p.sellerId?.toString());
        return this.sanitizeDigitalForPublicView({
          ...p,
          sellerName: seller ? seller.name : null,
          sellerVerified: seller ? !!seller.isVerified : false,
          variants: variantMap[p._id.toString()] || [],
        });
      }),
    );
  }

  /** Keyword search over active products (name/description, case-insensitive).
   *  Same response shape as `getProductsByCategoryId` so the app parses both
   *  with one model. */
  async searchProducts(
    q: string,
    page: number = 1,
    limit: number = 20,
    customerId?: string | null,
    storeId?: string,
  ) {
    const productModel = this.databaseService.repositories.productModel;

    const term = (q || '').trim();
    if (!term) {
      return {
        message: 'Search query is required',
        success: true,
        data: { total: 0, page, limit, products: [] },
      };
    }

    // User input goes into a regex — escape it so "c++" or "50% off" can't
    // break the query or turn into a pathological pattern.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');

    const query: any = {
      status: 'active',
      isDelete: false,
      $or: [{ name: regex }, { description: regex }],
    };

    // A single-store app build passes its own storeId so search never
    // surfaces another store's products — narrowed further below by the
    // active-stores gate, never widened.
    if (storeId) query.storeId = storeId;

    await this.restrictToActiveStores(query);

    const skip = (page - 1) * limit;
    const total = await productModel.countDocuments(query);
    const products = await productModel
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const productsWithVariants = await this.attachVariantsAndPricing(
      products,
      customerId,
    );

    return {
      message: 'Products fetched successfully',
      success: true,
      data: { total, page, limit, products: productsWithVariants },
    };
  }

  /** Active products for an explicit id list, preserving the given order —
   *  ids whose product is gone/inactive are silently dropped. */
  async getShapedProductsByIds(
    productIds: string[],
    customerId?: string | null,
  ) {
    if (!productIds.length) return [];
    const productModel = this.databaseService.repositories.productModel;

    // Same active-store gate as getProductsByCategoryId/searchProducts —
    // without it, a product whose store was suspended after being pinned/
    // recently-viewed/etc. would still be servable through this id-list path.
    const query: any = {
      _id: { $in: productIds },
      status: 'active',
      isDelete: false,
    };
    await this.restrictToActiveStores(query, false); // explicit id list (pinned/recently viewed); direct reads are gated by middleware

    const products = await productModel.find(query).lean();

    const shaped = await this.attachVariantsAndPricing(products, customerId);
    const byId = new Map(shaped.map((p) => [p._id.toString(), p]));
    return productIds.map((id) => byId.get(id)).filter(Boolean);
  }

  // ── Storefront promotion sections (Best Seller / New Arrival / Trending / Pinned) ──
  // Public, read-only. No new schema — Best Seller/Trending are derived from the
  // same order-aggregation util analytics already uses; New Arrival is a plain
  // sort; Pinned reuses `getShapedProductsByIds` (order-preserving by id list).

  async getPinnedProducts(storeId: string, customerId?: string | null) {
    const store = await this.databaseService.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).lean();
    if (!store) return { success: true, data: { products: [] } };
    const products = await this.getShapedProductsByIds((store as any).pinnedProductIds ?? [], customerId);
    return { success: true, data: { products } };
  }

  async getNewArrivals(storeId: string, limit: number = 12, customerId?: string | null) {
    const productModel = this.databaseService.repositories.productModel;
    const products = await productModel
      .find({ storeId, status: 'active', isDelete: false })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return { success: true, data: { products: await this.attachVariantsAndPricing(products, customerId) } };
  }

  private async getTopSellingProducts(storeId: string, from: Date, limit: number, customerId?: string | null) {
    const { orderModel, productModel } = this.databaseService.repositories;
    const sales = await aggregateProductSales(orderModel, from, new Date(), { 'sellerOrders.storeId': storeId });
    const topIds = [...sales].sort((a, b) => b.unitsSold - a.unitsSold).slice(0, limit).map((s) => s.productId);
    if (!topIds.length) return { success: true, data: { products: [] } };

    const products = await productModel.find({ _id: { $in: topIds }, storeId, status: 'active', isDelete: false }).lean();
    const byId = new Map(products.map((p: any) => [p._id.toString(), p]));
    const ordered = topIds.map((id) => byId.get(id)).filter(Boolean);
    return { success: true, data: { products: await this.attachVariantsAndPricing(ordered, customerId) } };
  }

  /** All-time unit-sales leaderboard for a store. */
  async getBestSellers(storeId: string, limit: number = 12, customerId?: string | null) {
    return this.getTopSellingProducts(storeId, new Date(0), limit, customerId);
  }

  /** Same leaderboard, narrowed to the last 7 days — a different signal ("hot right now" vs. "sells well overall"). */
  async getTrendingProducts(storeId: string, limit: number = 12, customerId?: string | null) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return this.getTopSellingProducts(storeId, sevenDaysAgo, limit, customerId);
  }

  async getProductById(idOrSlug: string, customerId?: string | null, storeId?: string, locale?: string) {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;
    const storeModel = this.databaseService.repositories.storeModel;

    // 1️⃣ Get product — resolve by slug (the canonical public URL) first,
    // falling back to the raw Mongo id so old bookmarked/shared
    // /marketplace/:id links keep working forever (ids never change, even
    // if the product is later renamed and its slug regenerates).
    let product = await productModel
      .findOne({
        slug: idOrSlug,
        status: 'active',
        isDelete: false,
      })
      .lean();

    if (!product && isValidObjectId(idOrSlug)) {
      product = await productModel
        .findOne({
          _id: idOrSlug,
          status: 'active',
          isDelete: false,
        })
        .lean();
    }

    // The handle a seller saved for this language (Translate & adapt); only with a store, as slugs are unique per store.
    const translatedHandle = storeId ? translatedHandleClause(locale, idOrSlug) : null;
    if (!product && translatedHandle) {
      product = await productModel.findOne({ storeId, status: 'active', isDelete: false, ...translatedHandle }).lean();
    }

    if (!product) {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    // A single-store app build passes its own storeId — a product belonging
    // to a different store must 404 here exactly like a genuinely-missing
    // one, the same way category/search/products-by-category were already
    // scoped, so a raw id/slug lookup can't be used to bypass those.
    if (storeId && product.storeId && product.storeId !== storeId) {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    // 2️⃣ Get seller name
    const seller = await sellerModel
      .findOne({
        _id: product.sellerId,
      })
      .select('name isVerified')
      .lean();

    // 3️⃣ Get store slug
    const store = await storeModel
      .findOne({
        _id: product.storeId,
        isDelete: false,
      })
      .select('slug name logo followersCount status')
      .lean();

    // A suspended/rejected store's product must not be directly viewable
    // even by id — getProductsByCategoryId/searchProducts/getPublicStoreProducts
    // already gate on this via restrictToActiveStores(); this was the one
    // remaining gap where a direct product link stayed reachable.
    if (!store || store.status !== 'active') {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    const [productWithSeller] = await this.attachCampaignBadges([
      this.sanitizeDigitalForPublicView({
        ...product,
        sellerName: seller ? seller.name : null,
        sellerVerified: seller ? !!seller.isVerified : false,
        storeSlug: store ? store.slug : null,
        storeName: store ? store.name : null,
        storeLogo: store ? store.logo : null,
        storeFollowersCount: store ? (store.followersCount ?? 0) : 0,
      }),
    ]);

    // 4️⃣ Get variants — must key off the resolved document's real _id, not
    // the route param (which may be a slug string, not the product's id).
    const rawVariants = await productVariantModel
      .find({
        productId: product._id.toString(),
        status: 'active',
        isDelete: false,
      })
      .lean();

    const variants = rawVariants;

    const defaultVariant =
      variants.length > 0
        ? variants.reduce(
            (min, v) => (v.price < min.price ? v : min),
            variants[0],
          )
        : null;

    // Same real fix as getVariantById — a fully public route, and until now
    // every variant's `costPrice` (the seller's own margin data) leaked
    // straight through with no sanitization.
    const publicVariants = variants.map((v: any) => { const { costPrice: _c, ...rest } = v; return rest; });
    const publicDefaultVariant = defaultVariant ? (() => { const { costPrice: _c, ...rest } = defaultVariant as any; return rest; })() : null;

    return {
      message: 'Product fetched successfully',
      success: true,
      data: {
        product: productWithSeller,
        variants: publicVariants,
        defaultVariant: publicDefaultVariant,
      },
    };
  }
  async getVariantById(variantId: string, storeId?: string) {
    const productModel = this.databaseService.repositories.productModel;
    const productVariantModel =
      this.databaseService.repositories.productVariantModel;
    const sellerModel = this.databaseService.repositories.sellerModel;

    // 1️⃣ Get variant
    const variant = await productVariantModel
      .findOne({
        _id: variantId,
        status: 'active',
        isDelete: false,
      })
      .lean();

    if (!variant) {
      return {
        message: 'Variant not found',
        success: false,
        data: null,
      };
    }

    // 2️⃣ Get product using variant.productId
    const product = await productModel
      .findOne({
        _id: variant.productId,
        status: 'active',
        isDelete: false,
      })
      .lean();

    if (!product) {
      return {
        message: 'Product not found',
        success: false,
        data: null,
      };
    }

    // Same cross-store guard as getProductById.
    if (storeId && product.storeId && product.storeId !== storeId) {
      return {
        message: 'Variant not found',
        success: false,
        data: null,
      };
    }

    // 3️⃣ Get seller name
    const seller = await sellerModel
      .findOne({
        _id: product.sellerId,
      })
      .select('name')
      .lean();

    const productWithSeller = this.sanitizeDigitalForPublicView({
      ...product,
      sellerName: seller ? seller.name : null,
    });

    // Real fix — this is a fully public, unauthenticated route (no
    // JwtAuthGuard at all, used for buyer-facing product pages); the raw
    // `.lean()` variant previously included `costPrice` (a seller's own
    // margin data) with no sanitization at all, unlike `product` above
    // (which already goes through `sanitizeDigitalForPublicView`). Found
    // while building the staff-facing `products.view_cost` permission split
    // — that split would have been cosmetic if the same cost figure leaked
    // to any anonymous caller regardless of permission.
    const { costPrice: _costPrice, ...publicVariant } = variant as any;

    return {
      message: 'Variant & Product fetched successfully',
      success: true,
      data: {
        variant: publicVariant,
        product: productWithSeller,
      },
    };
  }

  // ─── NEW APIS ───────────────────────────────────────────────────────────────

  /** Resolves and validates the `categoryId` a product is saved under.
   *  Categories are now store-scoped (a seller builds their own tree,
   *  entirely at their own discretion — see CategoriesService) instead of
   *  every product being forced onto the store's single fixed legacy root.
   *  Accepts either: a category the seller created for THIS store
   *  (`category.storeId === storeId`), or a legacy global/admin category
   *  (`category.storeId` null) — the latter kept only so a pre-existing
   *  store that still has an old `store.categoryId` root, or a product
   *  request that hasn't been updated to the new picker yet, keeps working
   *  unchanged. Falls back to the store's legacy `categoryId` only when the
   *  request sends none at all. */
  private async resolveProductCategoryId(
    storeId: string,
    legacyStoreCategoryId: string | null,
    requestedCategoryId?: string,
  ): Promise<string> {
    const categoryId = requestedCategoryId || legacyStoreCategoryId;
    if (!categoryId) {
      throw new BadRequestException(
        'Select a category for this product — create one from your store\'s Categories page first.',
      );
    }
    if (!isValidObjectId(categoryId)) {
      throw new BadRequestException('Invalid category selected');
    }
    const category = await this.databaseService.repositories.categoryModel.findOne({
      _id: categoryId,
      status: 'active',
      isDelete: false,
    });
    if (!category) {
      throw new BadRequestException('Selected category not found');
    }
    const belongsToStore = !category.storeId || String(category.storeId) === String(storeId);
    if (!belongsToStore) {
      throw new ForbiddenException('That category does not belong to your store');
    }
    return categoryId;
  }

  /**
   * Shipping profile a product is assigned to. Empty / the General profile / unknown-or-foreign id => null
   * (= General). A real custom profile of THIS store => its id.
   */
  private async resolveShippingProfileId(storeId: string, raw: unknown): Promise<string | null> {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string' || !isValidObjectId(raw)) throw new BadRequestException('Invalid shipping profile');
    const profile: any = await this.databaseService.repositories.shippingProfileModel
      .findOne({ _id: raw, storeId, isDelete: false })
      .select('isGeneral')
      .lean();
    if (!profile) throw new BadRequestException('Shipping profile not found');
    return profile.isGeneral ? null : String(profile._id);
  }

  // ── Shared helpers for the write paths below ──────────────────────────────

  private withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.connection.transaction(fn);
  }

  /** A Mongo duplicate-key error (a concurrent request won the race) becomes a readable 409 instead of a raw 500. */
  private rethrowDuplicate(err: any): never {
    if (err?.code === 11000) {
      const pattern = JSON.stringify(err?.keyPattern ?? err?.message ?? '');
      if (pattern.includes('sku')) {
        throw new ConflictException('A SKU is already used by another product in your store — SKUs must be unique.');
      }
      if (pattern.includes('slug')) {
        throw new ConflictException('A product with this name was just created — please try again.');
      }
    }
    throw err;
  }

  /** Every given SKU must be free inside the store (live variants only). `exceptProductId` lets a product keep its own SKUs. */
  private async assertSkusFree(storeId: string, skus: string[], exceptProductId?: string): Promise<void> {
    if (skus.length === 0) return;
    const filter: any = { storeId, sku: { $in: skus }, isDelete: false };
    if (exceptProductId) filter.productId = { $ne: exceptProductId };
    const clash: any = await this.databaseService.repositories.productVariantModel.findOne(filter).select('sku').lean();
    if (clash) throw new ConflictException(`SKU "${clash.sku}" is already used by another variant in your store — SKUs must be unique.`);
  }

  /**
   * The plan-limit pre-check is a count-then-insert and so can be beaten by two simultaneous creates. After the create is
   * committed we count again; if the store ended up over its limit this product is the one that crossed it, so it is removed
   * again and the caller is told (nothing was visible to buyers: it was created a moment ago, normally as a draft).
   */
  private async enforceProductLimitAfterCreate(storeId: string, productId: string): Promise<void> {
    if (!(await this.entitlementsService.isOverProductLimit(storeId))) return;
    const { productModel, productVariantModel } = this.databaseService.repositories;
    await productVariantModel.deleteMany({ productId });
    await productModel.deleteOne({ _id: productId });
    throw new BadRequestException('Product limit reached for your current plan — upgrade your platform plan to add more products.');
  }

  /** Validates + normalises one variant from a create request. Everything the database stores for a variant comes out of here. */
  private prepareVariantInput(v: any) {
    if (!v || typeof v !== 'object') throw new BadRequestException('Every variant must be an object');
    if (v.price === undefined || v.price === null) throw new BadRequestException('Every variant requires a price');
    const price = assertMoney(v.price, 'Price');
    const compareAtPrice = v.compareAtPrice === undefined || v.compareAtPrice === null ? null : assertMoney(v.compareAtPrice, 'Compare-at price');
    const unlimitedStock = !!v.unlimitedStock;
    const stock = v.stock === undefined || v.stock === null ? 0 : assertStockQuantity(v.stock);
    try {
      validateOptions(v.options);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    const customs = parseCustomsInput(v);
    if (customs.error) throw new BadRequestException(customs.error);
    return {
      price,
      compareAtPrice,
      stock: unlimitedStock ? 0 : stock,
      unlimitedStock,
      allowBackorder: !!v.allowBackorder,
      options: v.options ?? [],
      shippingWeight: v.shippingWeight ?? null,
      length: toDimensionCm(v.length),
      width: toDimensionCm(v.width),
      height: toDimensionCm(v.height),
      customs: { countryOfOrigin: null, hsCode: null, customsDescription: null, ...customs.value },
      taxable: v.taxable !== false,
      images: normalizeImages(v.images),
      videoUrl: normalizeVideoUrl(v.videoUrl),
      sku: normalizeSku(v.sku),
      barcode: normalizeBarcode(v.barcode),
      isDefault: v.isDefault === true,
    };
  }

  /** Redirect old product URLs to the new one after a rename (Shopify does the same), so shared links and search results keep working. */
  private async recordSlugRedirect(storeId: string, oldSlug: string, newSlug: string): Promise<void> {
    if (!oldSlug || !newSlug || oldSlug === newSlug) return;
    try {
      const { seoRedirectModel } = this.databaseService.repositories;
      const from = `/product/${oldSlug}`;
      const to = `/product/${newSlug}`;
      // renaming back to a slug that has an old redirect would otherwise create a loop
      await seoRedirectModel.deleteOne({ storeId, source: to });
      await seoRedirectModel.updateOne(
        { storeId, source: from },
        { $set: { destination: to, statusCode: 301, isActive: true, isDelete: false } },
        { upsert: true },
      );
      // earlier redirects that pointed at the old slug now go straight to the new one (no chains)
      await seoRedirectModel.updateMany({ storeId, destination: from }, { $set: { destination: to } });
    } catch {
      /* a failed redirect must never fail the rename */
    }
  }

  async addPhysicalProduct(sellerId: string, body: any) {
    const { storeModel, sellerModel, productModel, productVariantModel } = this.databaseService.repositories;

    const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const {
      storeId,
      categoryId: requestedCategoryId,
      subCategoryId,
      isListedOnSolvexo,
      variants,
      shippingProfileId: requestedShippingProfileId,
    } = body ?? {};

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new BadRequestException('Store not found');
    if (store.status !== 'active') throw new BadRequestException('Your store is not active');

    const allowsPhysical =
      store.productTypes?.includes(StoreProductType.PHYSICAL_PRODUCTS) ||
      store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
    if (!allowsPhysical) throw new BadRequestException('Your store does not support physical products');

    await this.entitlementsService.assertCanCreateProduct(storeId);

    const name = normalizeName(body.name);
    const description = normalizeDescription(body.description);
    const images = normalizeImages(body.images);
    const tags = normalizeTags(body.tags);
    const status = normalizeStatus(body.status);
    const scheduledAt = resolveScheduledAt(status, body.scheduledAt);

    if (!Array.isArray(variants) || variants.length === 0) {
      throw new BadRequestException('At least one variant is required');
    }
    if (variants.length > MAX_VARIANTS_PER_PRODUCT) {
      throw new BadRequestException(`A product can have at most ${MAX_VARIANTS_PER_PRODUCT} variants`);
    }
    const prepared = variants.map((v: any) => this.prepareVariantInput(v));
    const nameSets = new Set(prepared.map((v) => optionNameSet(v.options)));
    if (nameSets.size > 1) throw new BadRequestException('All variants must use the same attributes');
    const keys = prepared.map((v) => optionsKey(v.options));
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('Duplicate variants — each must have a unique combination of attributes');
    }
    if (prepared.filter((v) => v.isDefault).length > 1) {
      throw new BadRequestException('Only one variant may be marked as default');
    }
    const duplicatedSku = findDuplicateSku(prepared.map((v) => v.sku));
    if (duplicatedSku) throw new BadRequestException(`SKU "${duplicatedSku}" is used by more than one variant`);
    const explicitSkus = prepared.map((v) => v.sku).filter((s): s is string => !!s);
    await this.assertSkusFree(String(storeId), explicitSkus);

    const categoryId = await this.resolveProductCategoryId(storeId, store.categoryId, requestedCategoryId);
    const shippingProfileId = await this.resolveShippingProfileId(storeId, requestedShippingProfileId);

    const productId = new Types.ObjectId();
    const missing = prepared.filter((v) => !v.sku);
    const generated = generateSkus(String(productId), missing.length, explicitSkus);
    missing.forEach((v, i) => { v.sku = generated[i]; });
    const defaultIndex = prepared.findIndex((v) => v.isDefault);
    const slug = await generateUniqueSlug(productModel, name, { scope: { storeId } });

    let created: { product: any; variants: any[] };
    try {
      created = await this.withTransaction(async (session) => {
        const [product] = await (productModel as any).create(
          [{
            _id: productId,
            sellerId,
            storeId: store._id.toString(),
            name,
            slug,
            description,
            shippingProfileId,
            ...parseSellingOptions(body),
            productType: 'physical',
            type: 'physical',
            categoryId,
            subCategoryId: subCategoryId ?? null,
            images,
            videoUrl: normalizeVideoUrl(body.videoUrl),
            videoFirst: body.videoFirst === true,
            tags,
            digital: null,
            isListedOnSolvexo: isListedOnSolvexo ?? false,
            status,
            scheduledAt,
          }],
          { session },
        );
        const docs = prepared.map((v, index) => ({
          productId: String(productId),
          storeId: store._id.toString(),
          sku: v.sku,
          barcode: v.barcode,
          price: v.price,
          // Stamped from the owning store's own pricing currency — never client-supplied (see Store.baseCurrency).
          currency: store.baseCurrency,
          compareAtPrice: v.compareAtPrice,
          options: v.options,
          stock: v.stock,
          unlimitedStock: v.unlimitedStock,
          allowBackorder: v.allowBackorder,
          shippingWeight: v.shippingWeight,
          length: v.length,
          width: v.width,
          height: v.height,
          ...v.customs,
          taxable: v.taxable,
          images: v.images,
          isDefault: defaultIndex === -1 ? index === 0 : index === defaultIndex,
        }));
        const createdVariants = await productVariantModel.insertMany(docs, { session });
        return { product, variants: createdVariants };
      });
    } catch (err) {
      this.rethrowDuplicate(err);
    }

    await this.enforceProductLimitAfterCreate(String(storeId), String(productId));

    const defaultVariant = created.variants.find((v: any) => v.isDefault) || created.variants[0] || null;
    return {
      success: true,
      message: 'Physical product created successfully',
      data: { product: created.product, variants: created.variants, defaultVariant },
    };
  }

  /**
   * M4: publish a new version of one digital file. The array slot (fileIndex) stays, so every
   * DigitalAccess / order that points at it automatically serves the latest version; the old
   * version is kept in file.history. Returns the saved file (without history urls).
   */
  async publishDigitalFileVersion(sellerId: string, productId: string, fileIndex: number, body: any) {
    const { productModel } = this.databaseService.repositories;
    const product: any = await productModel.findOne({ _id: productId, sellerId, isDelete: false });
    if (!product || product.type !== 'digital' || !product.digital?.files?.[fileIndex]) throw new NotFoundException('File not found');
    const old = product.digital.files[fileIndex];
    if (old.archived) throw new BadRequestException('This file was removed');

    const next = normalizeDigital({ files: [{ ...(old.toObject?.() ?? old), ...pickNewFile(body) }] }, { files: [] }).files[0];
    const version = body?.version ? String(body.version).trim().slice(0, 30) : null;
    const changelog = body?.changelog ? String(body.changelog).trim().slice(0, 1000) : null;
    if (!version) throw new BadRequestException('version is required');
    if (version === old.version) throw new BadRequestException('Use a new version number');

    const history = [
      ...(old.history ?? []).slice(-49),
      { url: old.url, name: old.name, size: old.size ?? null, mimeType: old.mimeType ?? null, version: old.version ?? null, changelog: old.changelog ?? null, replacedAt: new Date() },
    ];
    const set: any = {
      [`digital.files.${fileIndex}.url`]: next.url,
      [`digital.files.${fileIndex}.name`]: next.name,
      [`digital.files.${fileIndex}.size`]: next.size,
      [`digital.files.${fileIndex}.mimeType`]: next.mimeType,
      [`digital.files.${fileIndex}.version`]: version,
      [`digital.files.${fileIndex}.changelog`]: changelog,
      [`digital.files.${fileIndex}.updatedAt`]: new Date(),
      [`digital.files.${fileIndex}.history`]: history,
    };
    await productModel.updateOne({ _id: productId, sellerId }, { $set: set });
    return { success: true, data: { fileIndex, version, name: next.name, storeId: String(product.storeId), productName: product.name, changelog } };
  }

  async addDigitalProduct(sellerId: string, body: any) {
    const { storeModel, sellerModel, productModel, productVariantModel } = this.databaseService.repositories;

    const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const {
      storeId,
      productType,
      categoryId: requestedCategoryId,
      subCategoryId,
      isListedOnSolvexo,
      digital,
      educationLevel,
      customLevel,
    } = body ?? {};

    if (!storeId) throw new BadRequestException('storeId is required');

    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new BadRequestException('Store not found');
    if (store.status !== 'active') throw new BadRequestException('Your store is not active');

    const allowsDigital =
      store.productTypes?.includes(StoreProductType.DIGITAL_DOWNLOADS) ||
      store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
    if (!allowsDigital) throw new BadRequestException('Your store does not support digital products');

    await this.entitlementsService.assertCanCreateProduct(storeId);

    const name = normalizeName(body.name);
    const description = normalizeDescription(body.description);
    const images = normalizeImages(body.images);
    const tags = normalizeTags(body.tags);
    const status = normalizeStatus(body.status);
    const scheduledAt = resolveScheduledAt(status, body.scheduledAt);
    if (body.price === undefined || body.price === null) throw new BadRequestException('Price is required');
    const price = assertMoney(body.price, 'Price');
    const compareAtPrice = body.compareAtPrice === undefined || body.compareAtPrice === null ? null : assertMoney(body.compareAtPrice, 'Compare-at price');

    const finalProductType = productType === 'educational' ? 'educational' : 'digital';

    // Tier-1/Tier-2 education taxonomy — required only for educational products.
    let finalEducationLevel: string | null = null;
    let normalizedFields: { customLevel: string | null; normalizedCustomLevel: string | null } = {
      customLevel: null,
      normalizedCustomLevel: null,
    };
    if (finalProductType === 'educational') {
      if (!educationLevel || !EDUCATION_LEVEL_VALUES.includes(educationLevel)) {
        throw new BadRequestException(`educationLevel is required and must be one of: ${EDUCATION_LEVEL_VALUES.join(', ')}`);
      }
      finalEducationLevel = educationLevel;
      if (educationLevel === EducationLevel.OTHER) {
        if (!customLevel || !String(customLevel).trim()) {
          throw new BadRequestException('customLevel is required when educationLevel is "other"');
        }
        const normalized = await this.educationLevelService.normalizeCustomLevel(String(customLevel));
        normalizedFields = { customLevel: normalized.customLevel, normalizedCustomLevel: normalized.normalizedCustomLevel };
      }
    }

    const categoryId = await this.resolveProductCategoryId(storeId, store.categoryId, requestedCategoryId);
    // Prepared BEFORE the transaction: it can upload/derive a preview file, which must not hold a transaction open.
    const digitalPayload = digital ? await this.prepareDigitalPreview(null, normalizeDigital(digital)) : null;

    const productId = new Types.ObjectId();
    const [sku] = generateSkus(String(productId), 1, []);
    const slug = await generateUniqueSlug(productModel, name, { scope: { storeId } });

    let created: { product: any; defaultVariant: any };
    try {
      created = await this.withTransaction(async (session) => {
        const [product] = await (productModel as any).create(
          [{
            _id: productId,
            sellerId,
            storeId: store._id.toString(),
            name,
            slug,
            description,
            productType: finalProductType,
            type: 'digital',
            categoryId,
            subCategoryId: subCategoryId ?? null,
            educationLevel: finalEducationLevel,
            customLevel: normalizedFields.customLevel,
            normalizedCustomLevel: normalizedFields.normalizedCustomLevel,
            images,
            videoUrl: normalizeVideoUrl(body.videoUrl),
            videoFirst: body.videoFirst === true,
            tags,
            digital: digitalPayload,
            isListedOnSolvexo: isListedOnSolvexo ?? false,
            status,
            scheduledAt,
          }],
          { session },
        );
        const [defaultVariant] = await (productVariantModel as any).create(
          [{
            productId: String(productId),
            storeId: store._id.toString(),
            sku,
            price,
            currency: store.baseCurrency,
            compareAtPrice,
            options: [],
            stock: 0,
            shippingWeight: null,
            images: [],
            isDefault: true,
          }],
          { session },
        );
        return { product, defaultVariant };
      });
    } catch (err) {
      this.rethrowDuplicate(err);
    }

    await this.enforceProductLimitAfterCreate(String(storeId), String(productId));

    return { success: true, message: 'Digital product created successfully', data: created };
  }

  async getSellerProductById(sellerId: string, productId: string) {
    const { productModel, productVariantModel } =
      this.databaseService.repositories;

    const product = await productModel
      .findOne({
        _id: productId,
        sellerId,
        isDelete: false,
      })
      .lean();

    if (!product) throw new NotFoundException('Product not found');

    const variants = await productVariantModel
      .find({
        productId,
        isDelete: false,
      })
      .lean();

    const defaultVariant =
      variants.find((v: any) => v.isDefault) || variants[0] || null;

    return {
      success: true,
      message: 'Product fetched successfully',
      data: { product, variants, defaultVariant },
    };
  }

  async getStoreProducts(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } =
      this.databaseService.repositories;

    const store = await storeModel.findOne({
      _id: storeId,
      sellerId,
      isDelete: false,
    });
    if (!store)
      throw new UnauthorizedException('Store not found or unauthorized');

    const page = parseInt(query.page) || 1;
    // Default 10 per page; pickers/exports may ask for more (capped). Search + sort now run server-side.
    const limit = Math.min(Math.max(parseInt(query.limit) || 10, 1), 1000);
    const skip = (page - 1) * limit;

    const filter = await buildStoreProductFilter({ productVariantModel }, storeId, sellerId, query);

    const total = await productModel.countDocuments(filter);
    const totalPages = Math.ceil(total / limit);

    const products = await productModel
      .find(filter)
      .sort(productSort(query.sort))
      .skip(skip)
      .limit(limit)
      .lean();

    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();

    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    const data = products.map((product: any) => ({
      ...product,
      variants: variantMap[product._id.toString()] || [],
    }));

    return {
      success: true,
      data: {
        pagination: { page, limit, totalPages, total },
        products: data,
      },
    };
  }

  async editProduct(sellerId: string, body: any) {
    const { productModel, productVariantModel, sellerModel } = this.databaseService.repositories;

    const {
      productId,
      name,
      description,
      categoryId: requestedCategoryId,
      subCategoryId,
      images,
      tags,
      isListedOnSolvexo,
      status,
      scheduledAt,
      digital,
      educationLevel,
      customLevel,
      price,
      compareAtPrice,
      templateKey,
      complementaryProductIds,
      shippingProfileId: requestedShippingProfileId,
    } = body ?? {};

    if (!productId) throw new BadRequestException('productId is required');
    if (!isValidObjectId(productId)) throw new BadRequestException('Invalid productId');

    const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product) throw new BadRequestException('Product not found');
    if (product.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to edit this product');

    const productUpdate: any = {};
    let renamedFrom: string | null = null;

    if (name !== undefined) {
      const cleanName = normalizeName(name);
      if (cleanName !== product.name) {
        productUpdate.name = cleanName;
        productUpdate.slug = await generateUniqueSlug(productModel, cleanName, { excludeId: productId, scope: { storeId: product.storeId } });
        renamedFrom = product.slug ?? null;
      }
    }

    if (description !== undefined) productUpdate.description = normalizeDescription(description);
    if (requestedCategoryId !== undefined) {
      productUpdate.categoryId = await this.resolveProductCategoryId(String(product.storeId), null, requestedCategoryId);
    }
    if (subCategoryId !== undefined) productUpdate.subCategoryId = subCategoryId;
    if (images !== undefined) productUpdate.images = normalizeImages(images);
    if (body?.videoUrl !== undefined) productUpdate.videoUrl = normalizeVideoUrl(body.videoUrl);
    if (body?.videoFirst !== undefined) productUpdate.videoFirst = body.videoFirst === true;
    if (tags !== undefined) productUpdate.tags = normalizeTags(tags);
    if (isListedOnSolvexo !== undefined) productUpdate.isListedOnSolvexo = !!isListedOnSolvexo;
    if (templateKey !== undefined) productUpdate.templateKey = templateKey;
    if (complementaryProductIds !== undefined) {
      const wanted = normalizeComplementaryIds(complementaryProductIds, String(productId));
      // Only this store's own, live products — never another seller's.
      const owned = wanted.length
        ? await productModel.find({ _id: { $in: wanted }, storeId: product.storeId, isDelete: false }).select('_id').lean()
        : [];
      const ownedIds = new Set(owned.map((p: any) => String(p._id)));
      productUpdate.complementaryProductIds = wanted.filter(id => ownedIds.has(id));
    }
    if (requestedShippingProfileId !== undefined && product.type === 'physical') {
      productUpdate.shippingProfileId = await this.resolveShippingProfileId(String(product.storeId), requestedShippingProfileId);
    }
    Object.assign(productUpdate, parseSellingOptions(body, product as any));
    if (status !== undefined) {
      const nextStatus = normalizeStatus(status);
      if (nextStatus === 'active' || nextStatus === 'scheduled') {
        // A product with no live variant has nothing to sell — never let it go live (or be scheduled).
        const liveVariants = await productVariantModel.countDocuments({ productId, isDelete: false });
        if (liveVariants === 0) throw new BadRequestException('Add at least one variant before publishing this product');
      }
      productUpdate.status = nextStatus;
      productUpdate.scheduledAt = resolveScheduledAt(nextStatus, scheduledAt);
    } else if (scheduledAt !== undefined && product.status === 'scheduled') {
      productUpdate.scheduledAt = resolveScheduledAt('scheduled', scheduledAt);
    }
    if (digital !== undefined && product.type === 'digital') {
      productUpdate.digital = await this.prepareDigitalPreview(product.digital?.preview, normalizeDigital(digital, product.digital));
    }

    if (educationLevel !== undefined && product.productType === 'educational') {
      if (!EDUCATION_LEVEL_VALUES.includes(educationLevel)) {
        throw new BadRequestException(`educationLevel must be one of: ${EDUCATION_LEVEL_VALUES.join(', ')}`);
      }
      productUpdate.educationLevel = educationLevel;
    }
    if (product.productType === 'educational') {
      const effectiveLevel = productUpdate.educationLevel ?? product.educationLevel;
      if (effectiveLevel === EducationLevel.OTHER) {
        if (customLevel !== undefined) {
          if (!String(customLevel).trim()) {
            throw new BadRequestException('customLevel is required when educationLevel is "other"');
          }
          const normalized = await this.educationLevelService.normalizeCustomLevel(String(customLevel));
          productUpdate.customLevel = normalized.customLevel;
          productUpdate.normalizedCustomLevel = normalized.normalizedCustomLevel;
        } else if (!product.customLevel) {
          throw new BadRequestException('customLevel is required when educationLevel is "other"');
        }
      } else if (productUpdate.educationLevel !== undefined) {
        productUpdate.customLevel = null;
        productUpdate.normalizedCustomLevel = null;
      }
    }

    // Digital/educational products still have exactly one (default) variant and no dedicated variant-management endpoints —
    // price/compareAtPrice edits for them stay routed through here. Physical products manage price per-variant exclusively
    // via the product-variants module.
    const variantUpdate: any = {};
    if (product.type !== 'physical') {
      if (price !== undefined) variantUpdate.price = assertMoney(price, 'Price');
      if (compareAtPrice !== undefined) variantUpdate.compareAtPrice = compareAtPrice === null ? null : assertMoney(compareAtPrice, 'Compare-at price');
    }

    let updatedProduct: any = product;
    let updatedVariant: any;
    try {
      await this.withTransaction(async (session) => {
        if (Object.keys(productUpdate).length > 0) {
          // Scoped by seller as well as id: the write itself can never touch someone else's product.
          updatedProduct = await productModel.findOneAndUpdate(
            { _id: productId, isDelete: false, sellerId },
            { $set: productUpdate },
            { new: true, session },
          );
          if (!updatedProduct) throw new ConflictException('This product was just deleted or changed — refresh and try again');
        }
        if (Object.keys(variantUpdate).length > 0) {
          updatedVariant = await productVariantModel.findOneAndUpdate(
            { productId, isDefault: true, isDelete: false },
            { $set: variantUpdate },
            { new: true, session },
          );
        }
      });
    } catch (err) {
      this.rethrowDuplicate(err);
    }

    if (renamedFrom) await this.recordSlugRedirect(String(product.storeId), renamedFrom, productUpdate.slug);

    const changed = [...Object.keys(productUpdate), ...Object.keys(variantUpdate)];
    if (changed.length > 0) {
      void this.activityLogService.log({
        storeId: String(product.storeId),
        category: 'products',
        action: 'product_updated',
        description: `Product "${updatedProduct?.name ?? product.name}" updated (${changed.join(', ')})`,
        actorId: sellerId,
        actorRole: 'seller',
        targetId: String(productId),
        targetType: 'product',
      } as any);
    }

    return {
      success: true,
      message: 'Product updated successfully',
      data: { product: updatedProduct, variant: updatedVariant },
    };
  }

  async deleteProduct(sellerId: string, productId: string) {
    const { productModel, sellerModel } = this.databaseService.repositories;
    if (!isValidObjectId(productId)) throw new BadRequestException('Invalid productId');

    const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const product = await productModel.findOne({ _id: productId, isDelete: false });
    if (!product) throw new BadRequestException('Product not found');
    if (product.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to delete this product');

    await this.withTransaction((session) =>
      softDeleteProducts(this.databaseService.repositories as any, { storeId: String(product.storeId), productIds: [String(productId)], session }),
    );

    void this.activityLogService.log({
      storeId: String(product.storeId),
      category: 'products',
      action: 'product_deleted',
      description: `Product "${product.name}" deleted`,
      actorId: sellerId,
      actorRole: 'seller',
      targetId: String(productId),
      targetType: 'product',
    } as any);

    return { success: true, message: 'Product deleted successfully', data: null };
  }

  /**
   * Real "Duplicate" — copies a product and every one of its variants into a brand-new DRAFT product (Shopify's one-click
   * duplicate). The copy is a separate listing, so: it counts against the plan's product limit; every variant gets its own
   * SKU (`<sku>-COPY`, SKUs are unique per store); barcodes are NOT copied (they identify one physical item) and stock starts
   * at 0 (copying counts would invent inventory that does not exist); the whole copy is written in one transaction.
   */
  async duplicateProduct(sellerId: string, productId: string) {
    const { productModel, productVariantModel, sellerModel } = this.databaseService.repositories;
    if (!isValidObjectId(productId)) throw new BadRequestException('Invalid productId');

    const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
    if (!seller) throw new UnauthorizedException('Unauthorized seller');

    const original = await productModel.findOne({ _id: productId, isDelete: false });
    if (!original) throw new BadRequestException('Product not found');
    if (original.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to duplicate this product');

    await this.entitlementsService.assertCanCreateProduct(original.storeId);

    const originalObj: any = original.toObject();
    const { _id: _origId, createdAt: _c, updatedAt: _u, __v: _v, ...copy } = originalObj;
    const newId = new Types.ObjectId();
    copy._id = newId;
    copy.name = `${String(copy.name).slice(0, PRODUCT_LIMITS.nameMax - 7)} (Copy)`;
    copy.slug = await generateUniqueSlug(productModel, copy.name, { scope: { storeId: copy.storeId } });
    copy.status = 'draft';
    copy.scheduledAt = null;
    copy.purchaseCount = 0;
    copy.viewCount = 0;
    copy.isFeatured = false;
    copy.earlyAccessUntil = null;

    const originalVariants: any[] = await productVariantModel.find({ productId, isDelete: false }).sort({ createdAt: 1 }).lean();
    const taken = new Set<string>(
      (await productVariantModel.find({ storeId: copy.storeId, isDelete: false, sku: /-COPY/ }).select('sku').lean()).map((v: any) => v.sku),
    );
    const fallbackSkus = generateSkus(String(newId), originalVariants.length, taken);
    const variantCopies = originalVariants.map((v: any, i: number) => {
      const { _id: _vid, createdAt: _vc, updatedAt: _vu, __v: _vv, ...rest } = v;
      return {
        ...rest,
        productId: String(newId),
        storeId: copy.storeId,
        sku: v.sku ? copySku(v.sku, taken) : fallbackSkus[i],
        barcode: null,
        stock: 0,
        committedStock: 0,
        damagedStock: 0,
        inTransitStock: 0,
      };
    });

    let created: any;
    try {
      created = await this.withTransaction(async (session) => {
        const [product] = await productModel.create([copy], { session });
        if (variantCopies.length > 0) await productVariantModel.insertMany(variantCopies, { session });
        return product;
      });
    } catch (err) {
      this.rethrowDuplicate(err);
    }

    await this.enforceProductLimitAfterCreate(String(copy.storeId), String(newId));

    return { success: true, message: 'Product duplicated', data: created };
  }

  /** Real CSV export of a store's whole product catalog — the Products list
   *  had no bulk export at all (found during the Catalog audit; the CSV
   *  export elsewhere in this area is Product SEO metadata only, a
   *  different thing). Deliberately read-only for this pass — a matching
   *  bulk CSV *import* is a real, separate, larger feature (needs per-row
   *  validation, category resolution, and a clear partial-failure story)
   *  and isn't safe to rush in alongside this. */
  async exportProductsCsv(sellerId: string, storeId: string): Promise<string> {
    const { productModel, productVariantModel, storeModel, categoryModel } = this.databaseService.repositories;
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new UnauthorizedException('Store not found or unauthorized');

    const products = await productModel
      .find({ storeId, sellerId, isDelete: false })
      .sort({ createdAt: -1 })
      .lean();
    const productIds = products.map((p: any) => p._id.toString());
    const variants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();
    const variantsByProduct: Record<string, any[]> = {};
    for (const v of variants) {
      if (!variantsByProduct[v.productId]) variantsByProduct[v.productId] = [];
      variantsByProduct[v.productId].push(v);
    }
    const categoryIds = [...new Set((products as any[]).map((p) => p.categoryId).filter(Boolean))];
    const categories = await categoryModel.find({ _id: { $in: categoryIds } }).lean();
    const categoryNameById: Record<string, string> = {};
    for (const c of categories as any[]) categoryNameById[c._id.toString()] = c.name;

    const rows: (string | number)[][] = [];
    for (const product of products as any[]) {
      const pVariants = variantsByProduct[product._id.toString()] || [];
      const defaultVariant = pVariants.find((v: any) => v.isDefault) || pVariants[0];
      const totalStock = pVariants.reduce((sum: number, v: any) => sum + (v.unlimitedStock ? 0 : v.stock || 0), 0);
      rows.push([
        product.name,
        defaultVariant?.sku ?? '',
        product.type,
        product.productType,
        product.status,
        defaultVariant?.price ?? 0,
        defaultVariant?.compareAtPrice ?? '',
        pVariants.some((v: any) => v.unlimitedStock) ? 'Unlimited' : totalStock,
        pVariants.length,
        (product.tags ?? []).join('; '),
        product.purchaseCount || 0,
        categoryNameById[product.categoryId] ?? '',
        defaultVariant?.length ?? '',
        defaultVariant?.width ?? '',
        defaultVariant?.height ?? '',
        defaultVariant?.countryOfOrigin ?? '',
        defaultVariant?.hsCode ?? '',
        defaultVariant?.customsDescription ?? '',
        defaultVariant && defaultVariant.taxable === false ? 'no' : 'yes',
        defaultVariant?.images?.[0] ?? product.images?.[0] ?? '',
        product.videoUrl ?? '',
      ]);
    }

    return toCsv(
      ['Name', 'SKU', 'Type', 'Product Type', 'Status', 'Price', 'Compare-at Price', 'Stock', 'Variant Count', 'Tags', 'All-Time Sales', 'Category', 'Length (cm)', 'Width (cm)', 'Height (cm)', 'Country of Origin', 'HS Code', 'Customs Description', 'Charge Tax', 'Image URL', 'Video URL'],
      rows,
    );
  }

  /** POST api/products/store-products/:storeId/import — shared bulk-import
   *  engine (see `product-bulk-import.ts`). Rows go through the real
   *  `addPhysicalProduct` / `editProduct` paths; `updateVariant` is passed in
   *  by the controller (ProductVariantsService) to avoid a constructor change. */
  async importProductsCsv(
    sellerId: string,
    storeId: string,
    csvText: string,
    updateVariant: (sellerId: string, productId: string, variantId: string, dto: any) => Promise<any>,
  ) {
    const { storeModel, categoryModel, productModel, productVariantModel } = this.databaseService.repositories;
    return importProductsCsvRows(
      {
        repos: { storeModel, categoryModel, productModel, productVariantModel },
        addPhysicalProduct: (s, body) => this.addPhysicalProduct(s, body),
        editProduct: (s, body) => this.editProduct(s, body),
        updateVariant,
      },
      sellerId,
      storeId,
      csvText,
    );
  }

  /** GET /api/products/education/facets — public, backs the Education marketplace's dynamic filter chips. */
  async getEducationFacets() {
    const facets = await this.educationLevelService.getFacets();
    return { success: true, data: facets };
  }

  /** GET /api/products/education/custom-level-suggestions — seller-only autocomplete while typing a custom level. */
  async getCustomLevelSuggestions(q: string) {
    const suggestions =
      await this.educationLevelService.getCustomLevelSuggestions(q);
    return { success: true, data: suggestions };
  }
}
