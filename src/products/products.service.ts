import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';

import { DatabaseService } from 'src/database/databaseservice';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateProductVariantDto } from './dto/productVariant.dto';

@Injectable()
export class ProductsService {
  constructor(
    private databaseService: DatabaseService,
  ) {}
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
    storeId: store._id.toString(),
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

async updateProduct(sellerId: string, body: any) {
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

  return {
    success: true,
    message: 'Updated successfully',
    data: { product: updatedProduct, variant: updatedVariant },
  };
}

private async getChildrenRecursiveOnlyId(parentId: string): Promise<string[]> {
  const categoryModel = this.databaseService.repositories.categoryModel;

  // Initialize array with parentId included
  let ids: string[] = [parentId]; // 👈 parent id included here

  // Only active & not deleted children
  const children = await categoryModel.find({
    parentId,
    status: "active",
    isDelete: false
  });

  for (const child of children) {
    ids.push(child._id.toString()); // add child id

    // recursively get sub-children ids
    const subChildIds = await this.getChildrenRecursiveOnlyId(child._id.toString());

    ids = ids.concat(subChildIds); // add all sub-children ids
  }

  return ids;
}

async getProductsByCategoryId(
  parentCategoryId?: string,
  page: number = 1,
  limit: number = 10
): Promise<any> {

  const productModel = this.databaseService.repositories.productModel;
  const productVariantModel = this.databaseService.repositories.productVariantModel;

  let query: any = {
    status: "active",
    isDelete: false
  };

  // 1️⃣ Agar category ID di gayi hai to filter lagao
  if (parentCategoryId) {
    const categoryIds = await this.getChildrenRecursiveOnlyId(parentCategoryId);

    categoryIds.unshift(parentCategoryId);

    query.categoryId = { $in: categoryIds };
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

  const productsWithVariants = products.map(p => ({
    ...p,
    variants: variantMap[p._id.toString()] || []
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

async getProductById(productId: string) {
  const productModel = this.databaseService.repositories.productModel;
  const productVariantModel = this.databaseService.repositories.productVariantModel;
  const sellerModel = this.databaseService.repositories.sellerModel; // 👈 seller model

  // 1️⃣ Get product
  const product = await productModel.findOne({
    _id: productId,
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

  // 2️⃣ Get seller name
  const seller = await sellerModel.findOne({
    _id: product.sellerId
  }).select("name").lean();

  // 👇 inject seller name into product
  const productWithSeller = {
    ...product,
    sellerName: seller ? seller.name : null
  };

  // 3️⃣ Get variants
  const variants = await productVariantModel.find({
    productId: productId,
    status: "active",
    isDelete: false
  }).lean();

  const defaultVariant = variants.length > 0
    ? variants.reduce((min, v) => v.price < min.price ? v : min, variants[0])
    : null;

  return {
    message: "Product fetched successfully",
    success: true,
    data: {
      product: productWithSeller, // 👈 updated product
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

}