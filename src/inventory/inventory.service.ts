import { Injectable, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DatabaseService } from 'src/database/databaseservice';

const LOW_STOCK_THRESHOLD = 10;

@Injectable()
export class InventoryService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getStoreInventory(sellerId: string, storeId: string, query: any) {
    if (!storeId) throw new BadRequestException('storeId is required');

    const { productModel, productVariantModel, storeModel } = this.databaseService.repositories;

    // seller ka store he ya nahi
    const store = await storeModel.findOne({ _id: storeId, sellerId, isDelete: false });
    if (!store) throw new ForbiddenException('Store not found or unauthorized');

    // filters
    const filter: any = { storeId, sellerId, isDelete: false };
    if (query.type && query.type !== 'all') filter.type = query.type;
    if (query.status && query.status !== 'all') filter.status = query.status;

    const page = parseInt(query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;

    const totalProducts = await productModel.countDocuments(filter);
    const totalPages = Math.ceil(totalProducts / limit);

    const products = await productModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean();

    // har product ke variants fetch karo
    const productIds = products.map((p: any) => p._id.toString());
    const allVariants = await productVariantModel
      .find({ productId: { $in: productIds }, isDelete: false })
      .lean();

    // productId → variants map
    const variantMap: Record<string, any[]> = {};
    for (const v of allVariants) {
      if (!variantMap[v.productId]) variantMap[v.productId] = [];
      variantMap[v.productId].push(v);
    }

    // stats counters
    let inStock = 0;
    let lowStock = 0;
    let outOfStock = 0;

    const productList = products.map((product: any) => {
      const variants = variantMap[product._id.toString()] || [];
      const isDigital = product.type === 'digital';

      let stockDisplay: string | number = '∞ Unlimited';
      let stockStatus = 'active';
      let price = 0;

      if (!isDigital) {
        const totalStock = variants.reduce((sum: number, v: any) => sum + (v.stock || 0), 0);
        stockDisplay = totalStock;

        if (totalStock === 0) {
          stockStatus = 'out_of_stock';
          outOfStock++;
        } else if (totalStock <= LOW_STOCK_THRESHOLD) {
          stockStatus = 'low_stock';
          lowStock++;
          inStock++;
        } else {
          stockStatus = 'active';
          inStock++;
        }
      } else {
        inStock++; // digital always in stock
      }

      // default variant ki price, fallback to min price
      const defaultVariant = variants.find((v: any) => v.isDefault) || variants[0];
      price = defaultVariant?.price || 0;

      // default variant ka sku
      const sku = defaultVariant?.sku || null;

      return {
        productId: product._id,
        sku,
        name: product.name,
        image: product.images?.[0] ?? null,
        type: product.type,
        stock: stockDisplay,
        stockStatus,
        status: product.status,
        scheduledAt: product.scheduledAt ?? null,
        price,
        allTimeSales: product.purchaseCount || 0,
      };
    });

    return {
      success: true,
      data: {
        stats: {
          totalProducts,
          inStock,
          lowStock,
          outOfStock,
        },
        pagination: {
          page,
          limit,
          totalPages,
          totalProducts,
        },
        products: productList,
      },
    };
  }
}
