import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
import { ProductType as StoreProductType } from 'src/store/schemas/store.schema';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { EducationLevel } from './schemas/product.schema';
import { EducationLevelService } from './education-level.service';

const EDUCATION_LEVEL_VALUES: string[] = Object.values(EducationLevel);

@Injectable()
export class ProductsService {
  constructor(
    private databaseService: DatabaseService,
    private activityLogService: ActivityLogService,
    private subscriptionBenefits: SubscriptionBenefitsService,
    private entitlementsService: EntitlementsService,
    private educationLevelService: EducationLevelService,
  ) {}

  /** Stamps a fresh product with an early-access window if the store has any active plan configuring one — non-subscribers can't see it until this passes. */
  private async applyEarlyAccessWindow(product: any) {
    const hours = await this.subscriptionBenefits.getStoreEarlyAccessHours(product.storeId);
    if (!hours) return;
    product.earlyAccessUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
    await product.save();
  }

  /** True if this product should stay hidden from this requester right now (still in its early-access window and the requester isn't a subscriber with early_access). */
  private async isHiddenByEarlyAccess(product: any, customerId?: string | null): Promise<boolean> {
    if (!product.earlyAccessUntil || product.earlyAccessUntil <= new Date()) return false;
    if (!customerId) return true;
    const entry = await this.subscriptionBenefits.getActiveBenefits(customerId, product.storeId);
    return !entry || !this.subscriptionBenefits.hasEarlyAccess(entry.benefits);
  }

  // Attaches subscriberPrice/youSaveUSD/discountPercent/planName to each
  // variant when the requester has an active, discount-granting subscription
  // to the product's store. Never hides or restricts the product itself —
  // this only ever adds optional pricing metadata.
  private applySubscriberPricing(variants: any[], product: { _id: any; categoryId?: string; subCategoryId?: string | null }, benefitsEntry: { benefits: any[]; planName: string } | undefined) {
    if (!benefitsEntry) return variants;
    return variants.map((v: any) => {
      const discount = this.subscriptionBenefits.resolveProductDiscount(benefitsEntry.benefits, product as any, v.price);
      if (!discount) return v;
      return {
        ...v,
        subscriberPrice: discount.subscriberPrice,
        youSaveUSD: discount.savingsUSD,
        discountPercent: discount.discountPercent,
        subscriberPlanName: benefitsEntry.planName,
        minOrderValueUSD: discount.minOrderValueUSD,
      };
    });
  }

  // Strips the private Cloudinary file manifest (publicId/name/size/mimeType)
  // from a digital product's `digital.files` before it's shown to a
  // non-owner — pre-purchase browsers only need to know *how many* files
  // they'll get, never the storage manifest itself. The actual bytes are
  // only ever reachable through OrdersService's signed download flow after
  // payment, regardless of this — but the manifest shouldn't leak either.
  private sanitizeDigitalForPublicView<T extends { digital?: any }>(product: T): T {
    if (!product?.digital) return product;
    const { files, ...safeDigital } = product.digital;
    return {
      ...product,
      digital: { ...safeDigital, fileCount: Array.isArray(files) ? files.length : 0 },
    };
  }
async getProductsByCategoryId(
  parentCategoryId?: string,
  page: number = 1,
  limit: number = 10,
  customerId?: string | null,
  productType?: string,
  educationLevel?: string,
  normalizedCustomLevel?: string,
): Promise<any> {

  const productModel = this.databaseService.repositories.productModel;
  const productVariantModel = this.databaseService.repositories.productVariantModel;

  let query: any = {
    status: "active",
    isDelete: false
  };

  // 0️⃣ Optional productType/educationLevel filters — used by verticals like the
  // Education marketplace to show only `productType: 'educational'` listings
  // from the same shared catalog, instead of a separate one. normalizedCustomLevel
  // is the Tier-2 drill-down, only meaningful when educationLevel === 'other'.
  if (productType) query.productType = productType;
  if (educationLevel) query.educationLevel = educationLevel;
  if (normalizedCustomLevel) query.normalizedCustomLevel = normalizedCustomLevel;

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
    const category = await this.databaseService.repositories.categoryModel.findOne({
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

  const skip = (page - 1) * limit;

  const total = await productModel.countDocuments(query);

  const products = await productModel.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const productIds = products.map(p => p._id.toString());

  // 2️⃣ Variants fetch
  const variants = await productVariantModel.find({
    productId: { $in: productIds },
    status: "active",
    isDelete: false
  }).lean();

  const variantMap: Record<string, any[]> = {};

  for (const v of variants) {
    if (!variantMap[v.productId]) {
      variantMap[v.productId] = [];
    }
    variantMap[v.productId].push(v);
  }

  // Batch-resolve subscriber pricing across every distinct store present in
  // this page of results — one query instead of N.
  const storeIds = [...new Set(products.map(p => p.storeId).filter(Boolean))];
  const benefitsMap = await this.subscriptionBenefits.getActiveBenefitsBatch(customerId, storeIds as string[]);

  const productsWithVariants = products.map(p => this.sanitizeDigitalForPublicView({
    ...p,
    variants: this.applySubscriberPricing(variantMap[p._id.toString()] || [], p, benefitsMap.get(p.storeId)),
  }));

  return {


    message: "Products fetched successfully",
    success: true,
    data: {
      total,
      page,
      limit,
      products: productsWithVariants
    }
  };
}

/** Variants + subscriber pricing for a page of lean product docs — the same
 *  shaping `getProductsByCategoryId` does, reusable for search/recently-viewed. */
private async attachVariantsAndPricing(products: any[], customerId?: string | null) {
  const productVariantModel = this.databaseService.repositories.productVariantModel;

  const productIds = products.map(p => p._id.toString());
  const variants = await productVariantModel.find({
    productId: { $in: productIds },
    status: "active",
    isDelete: false,
  }).lean();

  const variantMap: Record<string, any[]> = {};
  for (const v of variants) {
    if (!variantMap[v.productId]) variantMap[v.productId] = [];
    variantMap[v.productId].push(v);
  }

  const storeIds = [...new Set(products.map(p => p.storeId).filter(Boolean))];
  const benefitsMap = await this.subscriptionBenefits.getActiveBenefitsBatch(customerId ?? null, storeIds as string[]);

  return products.map(p => this.sanitizeDigitalForPublicView({
    ...p,
    variants: this.applySubscriberPricing(variantMap[p._id.toString()] || [], p, benefitsMap.get(p.storeId)),
  }));
}

/** Keyword search over active products (name/description, case-insensitive).
 *  Same response shape as `getProductsByCategoryId` so the app parses both
 *  with one model. */
async searchProducts(q: string, page: number = 1, limit: number = 20, customerId?: string | null) {
  const productModel = this.databaseService.repositories.productModel;

  const term = (q || '').trim();
  if (!term) {
    return { message: 'Search query is required', success: true, data: { total: 0, page, limit, products: [] } };
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

  const skip = (page - 1) * limit;
  const total = await productModel.countDocuments(query);
  const products = await productModel.find(query)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const productsWithVariants = await this.attachVariantsAndPricing(products, customerId);

  return {
    message: 'Products fetched successfully',
    success: true,
    data: { total, page, limit, products: productsWithVariants },
  };
}

/** Active products for an explicit id list, preserving the given order —
 *  ids whose product is gone/inactive are silently dropped. */
async getShapedProductsByIds(productIds: string[], customerId?: string | null) {
  if (!productIds.length) return [];
  const productModel = this.databaseService.repositories.productModel;

  const products = await productModel.find({
    _id: { $in: productIds },
    status: 'active',
    isDelete: false,
  }).lean();

  const shaped = await this.attachVariantsAndPricing(products, customerId);
  const byId = new Map(shaped.map(p => [p._id.toString(), p]));
  return productIds.map(id => byId.get(id)).filter(Boolean);
}

async getProductById(productId: string, customerId?: string | null) {
  const productModel = this.databaseService.repositories.productModel;
  const productVariantModel = this.databaseService.repositories.productVariantModel;
  const sellerModel = this.databaseService.repositories.sellerModel;
  const storeModel = this.databaseService.repositories.storeModel;

  // 1️⃣ Get product
  const product = await productModel.findOne({
    _id: productId,
    status: "active",
    isDelete: false
  }).lean();

  if (product && (await this.isHiddenByEarlyAccess(product, customerId))) {
    return { message: "Product not found", success: false, data: null };
  }

  if (!product) {
    return {
      message: "Product not found",
      success: false,
      data: null
    };
  }

  // 2️⃣ Get seller name
  const seller = await sellerModel.findOne({
    _id: product.sellerId
  }).select("name").lean();

  // 3️⃣ Get store slug
  const store = await storeModel.findOne({
    _id: product.storeId,
    isDelete: false
  }).select("slug name logo followersCount").lean();

  const productWithSeller = this.sanitizeDigitalForPublicView({
    ...product,
    sellerName: seller ? seller.name : null,
    storeSlug: store ? store.slug : null,
    storeName: store ? store.name : null,
    storeLogo: store ? store.logo : null,
    storeFollowersCount: store ? (store.followersCount ?? 0) : 0,
  });

  // 4️⃣ Get variants
  const rawVariants = await productVariantModel.find({
    productId: productId,
    status: "active",
    isDelete: false
  }).lean();

  const benefitsEntry = await this.subscriptionBenefits.getActiveBenefits(customerId, product.storeId);
  const variants = this.applySubscriberPricing(rawVariants, product, benefitsEntry ?? undefined);

  const defaultVariant = variants.length > 0
    ? variants.reduce((min, v) => v.price < min.price ? v : min, variants[0])
    : null;

  return {
    message: "Product fetched successfully",
    success: true,
    data: {
      product: productWithSeller,
      variants,
      defaultVariant
    }
  };
}
async getVariantById(variantId: string) {
  const productModel = this.databaseService.repositories.productModel;
  const productVariantModel = this.databaseService.repositories.productVariantModel;
  const sellerModel = this.databaseService.repositories.sellerModel;

  // 1️⃣ Get variant
  const variant = await productVariantModel.findOne({
    _id: variantId,
    status: "active",
    isDelete: false
  }).lean();

  if (!variant) {
    return {
      message: "Variant not found",
      success: false,
      data: null
    };
  }

  // 2️⃣ Get product using variant.productId
  const product = await productModel.findOne({
    _id: variant.productId,
    status: "active",
    isDelete: false
  }).lean();

  if (!product) {
    return {
      message: "Product not found",
      success: false,
      data: null
    };
  }

  // 3️⃣ Get seller name
  const seller = await sellerModel.findOne({
    _id: product.sellerId
  }).select("name").lean();

  const productWithSeller = this.sanitizeDigitalForPublicView({
    ...product,
    sellerName: seller ? seller.name : null
  });

  return {
    message: "Variant & Product fetched successfully",
    success: true,
    data: {
      variant,
      product: productWithSeller
    }
  };
}

// ─── NEW APIS ───────────────────────────────────────────────────────────────

async addPhysicalProduct(sellerId: string, body: any) {
  const { storeModel, sellerModel, productModel, productVariantModel } =
    this.databaseService.repositories;

  const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
  if (!seller) throw new UnauthorizedException('Unauthorized seller');

  const {
    storeId,
    name, description, subCategoryId, images, tags,
    isListedOnSolvexo, status, scheduledAt,
    price, compareAtPrice, size, color, stock, shippingWeight,
  } = body;

  if (!storeId) throw new BadRequestException('storeId is required');

  const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
  if (!store) throw new BadRequestException('Store not found');
  if (store.status !== 'active') throw new BadRequestException('Your store is not active');

  const allowsPhysical =
    store.productTypes?.includes(StoreProductType.PHYSICAL_PRODUCTS) ||
    store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
  if (!allowsPhysical) throw new BadRequestException('Your store does not support physical products');

  await this.entitlementsService.assertCanCreateProduct(storeId);

  if (!name) throw new BadRequestException('Product name is required');
  if (price === undefined || price === null) throw new BadRequestException('Price is required');

  if (status === 'scheduled' && !scheduledAt) {
    throw new BadRequestException('scheduledAt is required when status is scheduled');
  }

  const categoryId = store.categoryId;
  if (!categoryId) throw new BadRequestException('Your store has no category selected');

  const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
  let slug = baseSlug;
  let count = 1;
  while (await productModel.findOne({ slug })) {
    slug = `${baseSlug}-${count++}`;
  }

  const product = await productModel.create({
    sellerId,
    storeId: store._id.toString(),
    name,
    slug,
    description: description ?? null,
    productType: 'physical',
    type: 'physical',
    categoryId,
    subCategoryId: subCategoryId ?? null,
    images: images ?? [],
    tags: tags ?? [],
    digital: null,
    isListedOnSolvexo: isListedOnSolvexo ?? false,
    status: status ?? 'draft',
    scheduledAt: status === 'scheduled' ? new Date(scheduledAt) : null,
  });

  const sku = `SKU-${product._id.toString().slice(-6).toUpperCase()}-${Date.now().toString().slice(-4)}`;

  const defaultVariant = await productVariantModel.create({
    productId: product._id.toString(),
    sku,
    price,
    compareAtPrice: compareAtPrice ?? null,
    size: size ?? null,
    color: color ?? null,
    stock: stock ?? 0,
    shippingWeight: shippingWeight ?? null,
    images: [],
    isDefault: true,
  });

  return {
    success: true,
    message: 'Physical product created successfully',
    data: { product, defaultVariant },
  };
}

async addDigitalProduct(sellerId: string, body: any) {
  const { storeModel, sellerModel, productModel, productVariantModel } =
    this.databaseService.repositories;

  const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
  if (!seller) throw new UnauthorizedException('Unauthorized seller');

  const {
    storeId,
    name, description, productType, subCategoryId, images, tags,
    isListedOnSolvexo, status, scheduledAt,
    price, compareAtPrice,
    digital, educationLevel, customLevel,
  } = body;

  if (!storeId) throw new BadRequestException('storeId is required');

  const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
  if (!store) throw new BadRequestException('Store not found');
  if (store.status !== 'active') throw new BadRequestException('Your store is not active');

  const allowsDigital =
    store.productTypes?.includes(StoreProductType.DIGITAL_DOWNLOADS) ||
    store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
  if (!allowsDigital) throw new BadRequestException('Your store does not support digital products');

  await this.entitlementsService.assertCanCreateProduct(storeId);

  if (!name) throw new BadRequestException('Product name is required');
  if (price === undefined || price === null) throw new BadRequestException('Price is required');

  if (status === 'scheduled' && !scheduledAt) {
    throw new BadRequestException('scheduledAt is required when status is scheduled');
  }

  const finalProductType = productType === 'educational' ? 'educational' : 'digital';

  // Tier-1/Tier-2 education taxonomy — required only for educational products.
  let finalEducationLevel: string | null = null;
  let normalizedFields: { customLevel: string | null; normalizedCustomLevel: string | null } = {
    customLevel: null, normalizedCustomLevel: null,
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

  const categoryId = store.categoryId;
  if (!categoryId) throw new BadRequestException('Your store has no category selected');

  const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
  let slug = baseSlug;
  let count = 1;
  while (await productModel.findOne({ slug })) {
    slug = `${baseSlug}-${count++}`;
  }

  const product = await productModel.create({
    sellerId,
    storeId: store._id.toString(),
    name,
    slug,
    description: description ?? null,
    productType: finalProductType,
    type: 'digital',
    categoryId,
    subCategoryId: subCategoryId ?? null,
    educationLevel: finalEducationLevel,
    customLevel: normalizedFields.customLevel,
    normalizedCustomLevel: normalizedFields.normalizedCustomLevel,
    images: images ?? [],
    tags: tags ?? [],
    digital: digital ?? null,
    isListedOnSolvexo: isListedOnSolvexo ?? false,
    status: status ?? 'draft',
    scheduledAt: status === 'scheduled' ? new Date(scheduledAt) : null,
  });

  const sku = `SKU-${product._id.toString().slice(-6).toUpperCase()}-${Date.now().toString().slice(-4)}`;

  const defaultVariant = await productVariantModel.create({
    productId: product._id.toString(),
    sku,
    price,
    compareAtPrice: compareAtPrice ?? null,
    size: null,
    color: null,
    stock: 0,
    shippingWeight: null,
    images: [],
    isDefault: true,
  });

  return {
    success: true,
    message: 'Digital product created successfully',
    data: { product, defaultVariant },
  };
}


async getSellerProductById(sellerId: string, productId: string) {
  const { productModel, productVariantModel } = this.databaseService.repositories;

  const product = await productModel.findOne({
    _id: productId,
    sellerId,
    isDelete: false,
  }).lean();

  if (!product) throw new NotFoundException('Product not found');

  const variants = await productVariantModel.find({
    productId,
    isDelete: false,
  }).lean();

  const defaultVariant = variants.find((v: any) => v.isDefault) || variants[0] || null;

  return {
    success: true,
    message: 'Product fetched successfully',
    data: { product, variants, defaultVariant },
  };
}

async getStoreProducts(sellerId: string, storeId: string, query: any) {
  if (!storeId) throw new BadRequestException('storeId is required');

  const { productModel, productVariantModel, storeModel } = this.databaseService.repositories;

  const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
  if (!store) throw new UnauthorizedException('Store not found or unauthorized');

  const page = parseInt(query.page) || 1;
  const limit = 10;
  const skip = (page - 1) * limit;

  const filter: any = { storeId, sellerId, isDelete: false };
  if (query.type && query.type !== 'all') filter.type = query.type;
  if (query.status && query.status !== 'all') filter.status = query.status;

  const total = await productModel.countDocuments(filter);
  const totalPages = Math.ceil(total / limit);

  const products = await productModel
    .find(filter)
    .sort({ createdAt: -1 })
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
    productId, variantId,
    name, description, subCategoryId, images, tags, isListedOnSolvexo, status, scheduledAt,
    digital, educationLevel, customLevel,
    price, compareAtPrice, size, color, stock, shippingWeight,
  } = body;

  if (!productId) throw new BadRequestException('productId is required');

  const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
  if (!seller) throw new UnauthorizedException('Unauthorized seller');

  const product = await productModel.findOne({ _id: productId, isDelete: false });
  if (!product) throw new BadRequestException('Product not found');
  if (product.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to edit this product');

  const productUpdate: any = {};

  if (name && name !== product.name) {
    const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
    let slug = baseSlug;
    let count = 1;
    while (await productModel.findOne({ slug, _id: { $ne: productId } })) {
      slug = `${baseSlug}-${count++}`;
    }
    productUpdate.name = name;
    productUpdate.slug = slug;
  }

  if (description !== undefined) productUpdate.description = description;
  if (subCategoryId !== undefined) productUpdate.subCategoryId = subCategoryId;
  if (images !== undefined) productUpdate.images = images;
  if (tags !== undefined) productUpdate.tags = tags;
  if (isListedOnSolvexo !== undefined) productUpdate.isListedOnSolvexo = isListedOnSolvexo;
  if (status !== undefined) {
    if (status === 'scheduled' && !scheduledAt) {
      throw new BadRequestException('scheduledAt is required when status is scheduled');
    }
    productUpdate.status = status;
    productUpdate.scheduledAt = status === 'scheduled' ? new Date(scheduledAt) : null;
  }
  if (digital !== undefined && product.type === 'digital') productUpdate.digital = digital;

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
        if (!String(customLevel).trim()) throw new BadRequestException('customLevel is required when educationLevel is "other"');
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

  const updatedProduct = Object.keys(productUpdate).length > 0
    ? await productModel.findByIdAndUpdate(productId, productUpdate, { new: true })
    : product;

  let targetVariant: any;
  if (variantId) {
    targetVariant = await productVariantModel.findOne({ _id: variantId, productId, isDelete: false });
    if (!targetVariant) throw new BadRequestException('Variant not found');
  } else {
    targetVariant = await productVariantModel.findOne({ productId, isDefault: true, isDelete: false });
  }

  let updatedVariant = targetVariant;

  if (targetVariant) {
    const variantUpdate: any = {};

    if (price !== undefined) variantUpdate.price = price;
    if (compareAtPrice !== undefined) variantUpdate.compareAtPrice = compareAtPrice;

    if (product.type === 'physical') {
      if (size !== undefined) variantUpdate.size = size;
      if (color !== undefined) variantUpdate.color = color;
      if (stock !== undefined) variantUpdate.stock = stock;
      if (shippingWeight !== undefined) variantUpdate.shippingWeight = shippingWeight;
    }

    if (Object.keys(variantUpdate).length > 0) {
      updatedVariant = await productVariantModel.findByIdAndUpdate(
        targetVariant._id, variantUpdate, { new: true }
      );
    }
  }

  return {
    success: true,
    message: 'Product updated successfully',
    data: { product: updatedProduct, variant: updatedVariant },
  };
}

/** GET /api/products/education/facets — public, backs the Education marketplace's dynamic filter chips. */
async getEducationFacets() {
  const facets = await this.educationLevelService.getFacets();
  return { success: true, data: facets };
}

/** GET /api/products/education/custom-level-suggestions — seller-only autocomplete while typing a custom level. */
async getCustomLevelSuggestions(q: string) {
  const suggestions = await this.educationLevelService.getCustomLevelSuggestions(q);
  return { success: true, data: suggestions };
}

}