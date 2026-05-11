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

  } catch (error) {

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

  } catch (error) {

    throw new BadRequestException(
      error.message || 'Failed to create product variant'
    );

  }

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