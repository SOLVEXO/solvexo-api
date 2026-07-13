import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
import { ProductType as StoreProductType } from 'src/store/schemas/store.schema';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductVariantDto } from './dto/productVariant.dto';
import { ActivityLogService } from 'src/activity-log/activity-log.service';
import { SubscriptionBenefitsService } from 'src/subscriptions/subscription-benefits.service';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';

@Injectable()
export class ProductsService {
  constructor(
    private databaseService: DatabaseService,
    private activityLogService: ActivityLogService,
    private subscriptionBenefits: SubscriptionBenefitsService,
    private entitlementsService: EntitlementsService,
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
async addProduct(
  sellerId: string,
  role: string,
  createProductDto: CreateProductDto
) {
  try {

    const productModel = this.databaseService.repositories.productModel;

    // ADMIN CHECK
    if (role === 'admin') {

      const admin = await this.databaseService.repositories.adminModel.findOne({
        _id: sellerId,
        status: 'active',
        isDelete: false
      });

      if (!admin) {
        throw new UnauthorizedException('Unauthorized admin');
      }

    }

    // SELLER CHECK
    if (role === 'seller') {

      const seller = await this.databaseService.repositories.sellerModel.findOne({
        _id: sellerId,
        status: 'active',
        isDelete: false
      });

      if (!seller) {
        throw new UnauthorizedException('Unauthorized seller');
      }

    }

    const {
      name,
      slug,
      description,
      categoryId
    } = createProductDto;

    // check duplicate product for same seller
    const existingProduct = await productModel.findOne({
      name,
      slug,
      categoryId,
      sellerId,
      status: 'active',
      isDelete: false
    });

    if (existingProduct) {
      throw new BadRequestException('Product already exists');
    }

    const product = await productModel.create({
      name,
      slug,
      description: description ,
      sellerId,
      categoryId
    });

    return {
      message: 'Product created successfully',
      data: product
    };

  } catch (error: any) {

    throw new BadRequestException(
      error.message || 'Failed to create product'
    );

  }
}


async addProductVariant(
  sellerId: string,
  role: string,
  createProductVariantDto: CreateProductVariantDto
) {

  try {

    const productModel = this.databaseService.repositories.productModel;
    const variantModel = this.databaseService.repositories.productVariantModel;

    const {
      productId,
      sku,
      size,
      color,
      price,
      stock,
      images
    } = createProductVariantDto;

   
    const product = await productModel.findOne({
      _id: productId,
      status: 'active',
      isDelete: false
    });

    if (!product) {
      throw new BadRequestException('Product not found');
    }

    // seller authorization
    if (role === 'seller' && product.sellerId.toString() !== sellerId) {
      throw new UnauthorizedException('Unauthorized seller');
    }

    // duplicate SKU check
    const existingVariant = await variantModel.findOne({
      sku,
      productId,
      isDelete: false,
      status: 'active'
    });

    if (existingVariant) {
      throw new BadRequestException('Variant with this SKU already exists');
    }

    const variant = await variantModel.create({
      productId,
      sku,
      size: size || null,
      color: color || null,
      price,
      stock: stock || 0,
      images: images || []
    });

    return {
      message: 'Product variant created successfully',
      data: variant
    };

  } catch (error: any) {

    throw new BadRequestException(
      error.message || 'Failed to create product variant'
    );

  }

}


async createProduct(sellerId: string, body: any) {
  const { storeModel, sellerModel, productModel, productVariantModel } =
    this.databaseService.repositories;

  const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
  if (!seller) throw new UnauthorizedException('Unauthorized seller');

  const store = await storeModel.findOne({ sellerId, isDelete: false });
  if (!store) throw new BadRequestException('Store not found. Please create a store first');
  if (store.status !== 'active') throw new BadRequestException('Your store is not active');

  const storeId = store._id.toString();

  // Platform-plan product-count gate (Starter/Free etc.) — EntitlementsService
  // is the single owner of platform-tier limits; the older
  // PlatformSubscriptionsService gate was dropped here to avoid two competing
  // plan systems both blocking product creation.
  await this.entitlementsService.assertCanCreateProduct(storeId);

  const {
    name, description, productType, subCategoryId,
    images, tags, isListedOnSolvexo, status,
    price, compareAtPrice, stock, shippingWeight,
    size, color, fileUrl, fileName, fileSize, fileMimeType,
  } = body;

  if (!name) throw new BadRequestException('Product name is required');
  if (!productType) throw new BadRequestException('Product type is required');
  if (price === undefined || price === null) throw new BadRequestException('Price is required');

  const validTypes = ['physical', 'digital', 'educational'];
  if (!validTypes.includes(productType)) throw new BadRequestException('Invalid product type');

  if (store.productTypes?.length > 0) {
    const storeTypeMap: Record<string, string> = {
      physical_products: 'physical',
      digital_downloads: 'digital',
      educational_resources: 'educational',
    };
    const allowedTypes = store.productTypes.map((t: string) => storeTypeMap[t]).filter(Boolean);
    if (!allowedTypes.includes(productType)) {
      throw new BadRequestException(`Your store does not support "${productType}" product type`);
    }
  }

  const categoryId = store.categoryId;
  if (!categoryId) throw new BadRequestException('Your store has no category selected');

  const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
  let slug = baseSlug;
  let count = 1;
  while (await productModel.findOne({ slug })) {
    slug = `${baseSlug}-${count}`;
    count++;
  }

  const product = await productModel.create({
    sellerId,
    storeId,
    name,
    slug,
    description: description ?? null,
    productType,
    categoryId,
    subCategoryId: subCategoryId ?? null,
    images: images ?? [],
    tags: tags ?? [],
    isListedOnSolvexo: isListedOnSolvexo ?? false,
    status: status ?? 'draft',
  });

  if (product.status === 'active') await this.applyEarlyAccessWindow(product);

  const sku = `SKU-${product._id.toString().slice(-6).toUpperCase()}-${Date.now().toString().slice(-4)}`;

  let variantData: any = {
    productId: product._id.toString(),
    sku,
    price,
    compareAtPrice: compareAtPrice ?? null,
    isDefault: true,
    images: [],
  };

  if (productType === 'physical') {
    variantData.size = size ?? null;
    variantData.color = color ?? null;
    variantData.stock = stock ?? 0;
    variantData.shippingWeight = shippingWeight ?? null;
    variantData.fileUrl = null;
    variantData.fileName = null;
    variantData.fileSize = null;
    variantData.fileMimeType = null;
  } else {
    if (!fileUrl) throw new BadRequestException('fileUrl is required for digital/educational products');
    variantData.fileUrl = fileUrl;
    variantData.fileName = fileName ?? null;
    variantData.fileSize = fileSize ?? null;
    variantData.fileMimeType = fileMimeType ?? null;
    variantData.size = null;
    variantData.color = null;
    variantData.stock = 0;
    variantData.shippingWeight = null;
  }

  const defaultVariant = await productVariantModel.create(variantData);

  return {
    success: true,
    message: 'Product created successfully',
    data: { product, defaultVariant },
  };
}

async createVariant(sellerId: string, body: any) {
  const { productModel, productVariantModel, sellerModel } =
    this.databaseService.repositories;

  const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
  if (!seller) throw new UnauthorizedException('Unauthorized seller');

  const { productId, price, compareAtPrice, size, color, stock, shippingWeight, images, fileUrl, fileName, fileSize, fileMimeType } = body;

  if (!productId) throw new BadRequestException('productId is required');
  if (price === undefined || price === null) throw new BadRequestException('Price is required');

  const product = await productModel.findOne({ _id: productId, isDelete: false });
  if (!product) throw new BadRequestException('Product not found');

  if (product.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to add variant to this product');

  const sku = `SKU-${productId.slice(-6).toUpperCase()}-${Date.now().toString().slice(-4)}`;

  let variantData: any = {
    productId,
    sku,
    price,
    compareAtPrice: compareAtPrice ?? null,
    isDefault: false,
    images: images ?? [],
  };

  if (product.productType === 'physical') {
    variantData.size = size ?? null;
    variantData.color = color ?? null;
    variantData.stock = stock ?? 0;
    variantData.shippingWeight = shippingWeight ?? null;
    variantData.fileUrl = null;
    variantData.fileName = null;
    variantData.fileSize = null;
    variantData.fileMimeType = null;
  } else {
    if (!fileUrl) throw new BadRequestException('fileUrl is required for digital/educational products');
    variantData.fileUrl = fileUrl;
    variantData.fileName = fileName ?? null;
    variantData.fileSize = fileSize ?? null;
    variantData.fileMimeType = fileMimeType ?? null;
    variantData.size = null;
    variantData.color = null;
    variantData.stock = 0;
    variantData.shippingWeight = null;
  }

  const variant = await productVariantModel.create(variantData);

  return {
    success: true,
    message: 'Variant added successfully',
    data: variant,
  };
}

async updateProduct(sellerId: string, body: any, ip?: string, userAgent?: string) {
  const { productModel, productVariantModel, sellerModel } = this.databaseService.repositories;

  const {
    productId, variantId,
    name, description, subCategoryId, images, tags, isListedOnSolvexo, status,
    price, compareAtPrice, stock, shippingWeight, size, color,
    fileUrl, fileName, fileSize, fileMimeType,
  } = body;

  if (!productId) throw new BadRequestException('productId is required');

  const seller = await sellerModel.findOne({ _id: sellerId, status: 'active', isDelete: false });
  if (!seller) throw new UnauthorizedException('Unauthorized seller');

  const product = await productModel.findOne({ _id: productId, isDelete: false });
  if (!product) throw new BadRequestException('Product not found');

  if (product.sellerId !== sellerId) throw new UnauthorizedException('You are not authorized to edit this product');

  // ── Product update ──
  const productUpdate: any = {};

  if (name && name !== product.name) {
    const baseSlug = name.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
    let slug = baseSlug;
    let count = 1;
    while (await productModel.findOne({ slug, _id: { $ne: productId } })) {
      slug = `${baseSlug}-${count}`;
      count++;
    }
    productUpdate.name = name;
    productUpdate.slug = slug;
  }

  if (description !== undefined) productUpdate.description = description;
  if (subCategoryId !== undefined) productUpdate.subCategoryId = subCategoryId;
  if (images !== undefined) productUpdate.images = images;
  if (tags !== undefined) productUpdate.tags = tags;
  if (isListedOnSolvexo !== undefined) productUpdate.isListedOnSolvexo = isListedOnSolvexo;
  if (status !== undefined) productUpdate.status = status;

  const updatedProduct = Object.keys(productUpdate).length > 0
    ? await productModel.findByIdAndUpdate(productId, productUpdate, { new: true })
    : product;

  // ── Variant update ──
  let targetVariant: any;

  if (variantId) {
    targetVariant = await productVariantModel.findOne({ _id: variantId, productId, isDelete: false });
    if (!targetVariant) throw new BadRequestException('Variant not found');
  } else {
    targetVariant = await productVariantModel.findOne({ productId, isDefault: true, isDelete: false });
  }

  let updatedVariant = targetVariant;
  const oldPrice = targetVariant ? (targetVariant as any).price : undefined;

  if (targetVariant) {
    const variantUpdate: any = {};

    if (price !== undefined) variantUpdate.price = price;
    if (compareAtPrice !== undefined) variantUpdate.compareAtPrice = compareAtPrice;

    if (product.productType === 'physical') {
      if (size !== undefined) variantUpdate.size = size;
      if (color !== undefined) variantUpdate.color = color;
      if (stock !== undefined) variantUpdate.stock = stock;
      if (shippingWeight !== undefined) variantUpdate.shippingWeight = shippingWeight;
    } else {
      if (fileUrl !== undefined) variantUpdate.fileUrl = fileUrl;
      if (fileName !== undefined) variantUpdate.fileName = fileName;
      if (fileSize !== undefined) variantUpdate.fileSize = fileSize;
      if (fileMimeType !== undefined) variantUpdate.fileMimeType = fileMimeType;
    }

    if (Object.keys(variantUpdate).length > 0) {
      updatedVariant = await productVariantModel.findByIdAndUpdate(
        targetVariant._id, variantUpdate, { new: true }
      );
    }
  }

  const priceChanged = price !== undefined && oldPrice !== undefined && price !== oldPrice;

  this.activityLogService.log({
    storeId: (updatedProduct as any).storeId,
    category: 'products',
    action: priceChanged ? 'product_price_updated' : 'product_updated',
    description: priceChanged
      ? `${(updatedProduct as any).name}: $${oldPrice} → $${price}`
      : `Updated ${(updatedProduct as any).name}`,
    actorId: sellerId,
    actorRole: 'seller',
    targetId: productId,
    targetType: 'product',
    ip,
    userAgent,
  });

  return {
    success: true,
    message: 'Updated successfully',
    data: { product: updatedProduct, variant: updatedVariant },
  };
}


async getProductsByCategoryId(
  parentCategoryId?: string,
  page: number = 1,
  limit: number = 10,
  customerId?: string | null,
): Promise<any> {

  const productModel = this.databaseService.repositories.productModel;
  const productVariantModel = this.databaseService.repositories.productVariantModel;

  let query: any = {
    status: "active",
    isDelete: false
  };

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

  const productsWithVariants = products.map(p => ({
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

  const productWithSeller = {
    ...product,
    sellerName: seller ? seller.name : null,
    storeSlug: store ? store.slug : null,
    storeName: store ? store.name : null,
    storeLogo: store ? store.logo : null,
    storeFollowersCount: store ? (store.followersCount ?? 0) : 0,
  };

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

  const productWithSeller = {
    ...product,
    sellerName: seller ? seller.name : null
  };

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
    digital,
  } = body;

  if (!storeId) throw new BadRequestException('storeId is required');

  const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
  if (!store) throw new BadRequestException('Store not found');
  if (store.status !== 'active') throw new BadRequestException('Your store is not active');

  const allowsDigital =
    store.productTypes?.includes(StoreProductType.DIGITAL_DOWNLOADS) ||
    store.productTypes?.includes(StoreProductType.EDUCATIONAL_RESOURCES);
  if (!allowsDigital) throw new BadRequestException('Your store does not support digital products');

  if (!name) throw new BadRequestException('Product name is required');
  if (price === undefined || price === null) throw new BadRequestException('Price is required');

  if (status === 'scheduled' && !scheduledAt) {
    throw new BadRequestException('scheduledAt is required when status is scheduled');
  }

  const finalProductType = productType === 'educational' ? 'educational' : 'digital';

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
    digital,
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

}