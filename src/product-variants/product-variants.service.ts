import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ClientSession, Connection } from 'mongoose';
import { assertMoney, assertStockQuantity, generateSkus, normalizeBarcode, normalizeImages, normalizeSku } from '../products/product-input.util';
import { DatabaseService } from '@/database/databaseservice';
import { ActivityLogService } from '@/activity-log/activity-log.service';
import { buildDiffMetadata } from '@/common/activity-diff.util';
import { CreateVariantDto } from './dto/create-variant.dto';
import { parseCustomsInput } from '@/shipping-rates/customs.util';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { importVariantsCsv as importVariantsCsvRows } from './variant-bulk-import';
import {
  optionNameSet,
  optionsKey,
  VariantOptionInput,
} from '../products/variant-options.util';

/** Same ceiling as ProductsService — a variant list a seller can actually manage. */
const MAX_VARIANTS_PER_PRODUCT = 250;

@Injectable()
export class ProductVariantsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly activityLogService: ActivityLogService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private async loadOwnedPhysicalProduct(sellerId: string, productId: string) {
    const { productModel } = this.databaseService.repositories;
    const product = await productModel.findOne({
      _id: productId,
      isDelete: false,
    });
    if (!product) throw new NotFoundException('Product not found');
    if (product.sellerId !== sellerId) {
      throw new ForbiddenException(
        'You are not authorized to manage this product',
      );
    }
    if (product.type !== 'physical') {
      throw new BadRequestException('Only physical products support variants');
    }
    return product;
  }

  private async getActiveVariants(
    productId: string,
    excludeVariantId?: string,
  ) {
    const { productVariantModel } = this.databaseService.repositories;
    const filter: any = { productId, isDelete: false };
    if (excludeVariantId) filter._id = { $ne: excludeVariantId };
    return productVariantModel.find(filter).lean();
  }

  private assertConsistentAndUnique(
    existing: { options: VariantOptionInput[] }[],
    incoming: VariantOptionInput[],
  ) {
    const incomingKey = optionsKey(incoming);
    const incomingNameSet = optionNameSet(incoming);

    if (existing.length > 0) {
      const existingNameSet = optionNameSet(existing[0].options ?? []);
      if (incomingNameSet !== existingNameSet) {
        throw new BadRequestException(
          "This product's variants must all use the same attributes",
        );
      }
      const duplicate = existing.some(
        (v) => optionsKey(v.options ?? []) === incomingKey,
      );
      if (duplicate) {
        throw new BadRequestException(
          'A variant with this exact combination of attributes already exists',
        );
      }
    }
  }

  /** A SKU must be free inside the whole store; `exceptVariantId` lets a variant keep its own. */
  private async assertSkuFree(storeId: string, sku: string, exceptVariantId?: string): Promise<void> {
    const filter: any = { storeId, sku, isDelete: false };
    if (exceptVariantId) filter._id = { $ne: exceptVariantId };
    const clash = await this.databaseService.repositories.productVariantModel.exists(filter);
    if (clash) throw new ConflictException(`SKU "${sku}" is already used by another variant in your store — SKUs must be unique.`);
  }

  private rethrowDuplicate(err: any): never {
    if (err?.code === 11000 && JSON.stringify(err?.keyPattern ?? err?.message ?? '').includes('sku')) {
      throw new ConflictException('That SKU is already used by another variant in your store — SKUs must be unique.');
    }
    throw err;
  }

  /**
   * Product-level stock edit vs per-location stock: with ONE location row the row follows the edit (otherwise the two
   * sources drift apart); with several locations a single number is ambiguous, so the edit is refused and the seller is
   * pointed at the per-location adjustment in Inventory.
   */
  private async syncLocationStock(variantId: string, newStock: number, inTransit: number, session: ClientSession): Promise<void> {
    const { variantLocationStockModel } = this.databaseService.repositories;
    const rows: any[] = await variantLocationStockModel.find({ variantId }).session(session).lean();
    if (rows.length > 1) {
      throw new BadRequestException('This variant has stock in several locations — adjust it per location under Inventory.');
    }
    if (rows.length === 1) {
      await variantLocationStockModel.updateOne({ _id: rows[0]._id }, { $set: { stock: Math.max(0, newStock - (inTransit || 0)) } }, { session });
    }
  }

  async addVariant(sellerId: string, productId: string, dto: CreateVariantDto) {
    const { productVariantModel, storeModel } = this.databaseService.repositories;
    const product = await this.loadOwnedPhysicalProduct(sellerId, productId);

    // Stamped from the owning store's own pricing currency, not the product/a sibling variant — same rule as
    // ProductsService's addPhysicalProduct/addDigitalProduct.
    const store = await storeModel.findOne({ _id: product.storeId, isDelete: false });
    if (!store) throw new NotFoundException('Store not found');

    const options = dto.options ?? [];
    const price = assertMoney(dto.price, 'Price');
    const compareAtPrice = dto.compareAtPrice === undefined || dto.compareAtPrice === null ? null : assertMoney(dto.compareAtPrice, 'Compare-at price');
    const unlimitedStock = !!dto.unlimitedStock;
    const stock = unlimitedStock || dto.stock === undefined || dto.stock === null ? 0 : assertStockQuantity(dto.stock);
    const explicitSku = normalizeSku(dto.sku);
    const barcode = normalizeBarcode(dto.barcode);
    const customsParsed = parseCustomsInput(dto);
    if (customsParsed.error) throw new BadRequestException(customsParsed.error);
    const customsForCreate = { countryOfOrigin: null, hsCode: null, customsDescription: null, ...customsParsed.value };
    if (explicitSku) await this.assertSkuFree(String(product.storeId), explicitSku);

    let variantId: string;
    try {
      variantId = await this.connection.transaction(async (session) => {
        const existing: any[] = await productVariantModel.find({ productId, isDelete: false }).session(session).lean();
        if (existing.length >= MAX_VARIANTS_PER_PRODUCT) {
          throw new BadRequestException(`A product can have at most ${MAX_VARIANTS_PER_PRODUCT} variants`);
        }
        this.assertConsistentAndUnique(existing as any, options);
        const sku = explicitSku ?? generateSkus(String(productId), 1, existing.map((v) => v.sku), existing.length + 1)[0];
        const makeDefault = existing.length === 0 || dto.isDefault === true;
        if (makeDefault && existing.length > 0) {
          await productVariantModel.updateMany({ productId, isDelete: false }, { $set: { isDefault: false } }, { session });
        }
        const [created] = await (productVariantModel as any).create(
          [{
            productId,
            storeId: String(product.storeId),
            sku,
            barcode,
            price,
            currency: store.baseCurrency,
            compareAtPrice,
            options,
            stock,
            unlimitedStock,
            allowBackorder: !!dto.allowBackorder,
            shippingWeight: dto.shippingWeight ?? null,
            length: dto.length ?? null,
            width: dto.width ?? null,
            height: dto.height ?? null,
            ...customsForCreate,
            taxable: dto.taxable !== false,
            images: normalizeImages(dto.images),
            isDefault: makeDefault,
          }],
          { session },
        );
        return String(created._id);
      });
    } catch (err) {
      this.rethrowDuplicate(err);
    }

    return {
      success: true,
      message: 'Variant added successfully',
      data: await productVariantModel.findById(variantId!),
    };
  }

  async updateVariant(
    sellerId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
    ip?: string,
    userAgent?: string,
  ) {
    const { productVariantModel } = this.databaseService.repositories;
    const product = await this.loadOwnedPhysicalProduct(sellerId, productId);

    const variant = await productVariantModel.findOne({ _id: variantId, productId, isDelete: false });
    if (!variant) throw new NotFoundException('Variant not found');

    if (dto.options !== undefined) {
      const others = await this.getActiveVariants(productId, variantId);
      this.assertConsistentAndUnique(others as any, dto.options);
    }

    if (dto.isDefault === false && variant.isDefault) {
      throw new BadRequestException('Cannot unset the default variant directly — set another variant as default instead');
    }

    const update: any = {};
    if (dto.price !== undefined) update.price = assertMoney(dto.price, 'Price');
    if (dto.compareAtPrice !== undefined) update.compareAtPrice = dto.compareAtPrice === null ? null : assertMoney(dto.compareAtPrice, 'Compare-at price');
    if (dto.options !== undefined) update.options = dto.options;
    let newStock: number | null = null;
    if (dto.stock !== undefined) {
      newStock = assertStockQuantity(dto.stock);
      // Can't set stock below what pending orders already reserved — see ProductVariant.committedStock.
      if (!variant.unlimitedStock && newStock < (variant.committedStock || 0)) {
        throw new BadRequestException(`Cannot set stock below ${variant.committedStock} — that many units are reserved by pending orders`);
      }
      update.stock = newStock;
    }
    if (dto.unlimitedStock !== undefined) update.unlimitedStock = !!dto.unlimitedStock;
    if (dto.shippingWeight !== undefined) update.shippingWeight = dto.shippingWeight;
    if (dto.length !== undefined) update.length = dto.length;
    if (dto.width !== undefined) update.width = dto.width;
    if (dto.height !== undefined) update.height = dto.height;
    {
      const customs = parseCustomsInput(dto);
      if (customs.error) throw new BadRequestException(customs.error);
      Object.assign(update, customs.value);
    }
    if (dto.taxable !== undefined) update.taxable = !!dto.taxable;
    if (dto.images !== undefined) update.images = normalizeImages(dto.images);
    if (dto.sku !== undefined) {
      const sku = normalizeSku(dto.sku);
      if (!sku) throw new BadRequestException('SKU cannot be empty');
      if (sku !== variant.sku) {
        await this.assertSkuFree(String(product.storeId), sku, variantId);
        update.sku = sku;
      }
    }
    if (dto.barcode !== undefined) update.barcode = normalizeBarcode(dto.barcode);
    if (dto.reorderPoint !== undefined) update.reorderPoint = assertStockQuantity(dto.reorderPoint);
    if (dto.costPrice !== undefined) update.costPrice = dto.costPrice === null ? null : assertMoney(dto.costPrice, 'Cost price');
    if (dto.allowBackorder !== undefined) update.allowBackorder = !!dto.allowBackorder;
    if (dto.trackLots !== undefined) update.trackLots = !!dto.trackLots;
    if (dto.trackSerials !== undefined) update.trackSerials = !!dto.trackSerials;

    const stockChanging = newStock !== null && newStock !== variant.stock;
    const makeDefault = dto.isDefault === true && !variant.isDefault;

    let updated: any = variant;
    if (Object.keys(update).length > 0 || makeDefault) {
      try {
        updated = await this.connection.transaction(async (session) => {
          // The stock write only applies if nobody changed this variant's stock since we read it (a sale, an adjustment, a
          // second dashboard tab): a stale absolute number must never silently overwrite a newer one.
          const filter: any = { _id: variantId, productId, isDelete: false };
          if (stockChanging) filter.stock = variant.stock;
          const doc = Object.keys(update).length > 0
            ? await productVariantModel.findOneAndUpdate(filter, { $set: update }, { new: true, session })
            : await productVariantModel.findOne({ _id: variantId, productId, isDelete: false }).session(session);
          if (!doc) throw new ConflictException('This variant was just changed by someone else — refresh and try again');
          if (stockChanging) await this.syncLocationStock(variantId, newStock as number, variant.inTransitStock || 0, session);
          if (makeDefault) {
            await productVariantModel.updateMany({ productId, isDelete: false, _id: { $ne: variantId } }, { $set: { isDefault: false } }, { session });
            await productVariantModel.updateOne({ _id: variantId }, { $set: { isDefault: true } }, { session });
            doc.isDefault = true;
          }
          return doc;
        });
      } catch (err) {
        this.rethrowDuplicate(err);
      }
    }

    // A real audit trail for manual stock adjustments and price edits (who changed it, from/to what value).
    if (stockChanging) {
      await this.activityLogService.log({
        storeId: product.storeId,
        category: 'products',
        action: 'inventory_adjusted',
        description: `Stock for "${product.name}"${variant.sku ? ` (${variant.sku})` : ''} adjusted: ${variant.stock} → ${newStock}`,
        actorId: sellerId,
        actorRole: 'seller',
        targetId: variantId,
        targetType: 'product_variant',
        ip,
        userAgent,
        metadata: buildDiffMetadata({ stock: variant.stock }, { stock: newStock }, ['stock']),
      });
    }
    const priceDiff = buildDiffMetadata(
      { price: variant.price, compareAtPrice: variant.compareAtPrice },
      { price: update.price ?? variant.price, compareAtPrice: update.compareAtPrice !== undefined ? update.compareAtPrice : variant.compareAtPrice },
      ['price', 'compareAtPrice'],
    );
    if (priceDiff) {
      await this.activityLogService.log({
        storeId: product.storeId,
        category: 'products',
        action: 'price_updated',
        description: `Price for "${product.name}"${variant.sku ? ` (${variant.sku})` : ''} updated`,
        actorId: sellerId,
        actorRole: 'seller',
        targetId: variantId,
        targetType: 'product_variant',
        ip,
        userAgent,
        metadata: priceDiff,
      });
    }

    return { success: true, message: 'Variant updated successfully', data: updated };
  }

  async deleteVariant(sellerId: string, productId: string, variantId: string) {
    const { productVariantModel, cartModel, wishListModel } = this.databaseService.repositories;
    const product = await this.loadOwnedPhysicalProduct(sellerId, productId);

    const variant = await productVariantModel.findOne({ _id: variantId, productId, isDelete: false });
    if (!variant) throw new NotFoundException('Variant not found');

    await this.connection.transaction(async (session) => {
      const remaining: any[] = await productVariantModel
        .find({ productId, isDelete: false, _id: { $ne: variantId } })
        .session(session)
        .lean();
      if (remaining.length === 0) {
        throw new BadRequestException('Cannot delete the last variant — a product must have at least one variant');
      }
      await productVariantModel.updateOne({ _id: variantId }, { $set: { isDelete: true, isDefault: false } }, { session });
      if (variant.isDefault) {
        const cheapest = remaining.reduce((a, b) => (a.price < b.price ? a : b));
        await productVariantModel.updateOne({ _id: cheapest._id }, { $set: { isDefault: true } }, { session });
      }
      // the variant can no longer be bought: take it out of open carts and wishlists
      await cartModel.updateMany(
        { storeId: String(product.storeId), 'items.productVariantId': variantId },
        { $pull: { items: { productVariantId: variantId } } },
        { session },
      );
      await wishListModel.deleteMany({ storeId: String(product.storeId), productVariantId: variantId }, { session });
    });

    return { success: true, message: 'Variant deleted successfully', data: await this.getActiveVariants(productId) };
  }

  async listVariants(sellerId: string, productId: string) {
    await this.loadOwnedPhysicalProduct(sellerId, productId);
    return {
      success: true,
      message: 'Variants fetched successfully',
      data: await this.getActiveVariants(productId),
    };
  }

  /** POST api/products/store-products/:storeId/variants/import — shared
   *  bulk-import engine (see `variant-bulk-import.ts`); every row goes through
   *  addVariant/updateVariant above. */
  async importVariantsCsv(sellerId: string, storeId: string, csvText: string) {
    const { storeModel, productModel, productVariantModel } = this.databaseService.repositories;
    return importVariantsCsvRows(
      {
        repos: { storeModel, productModel, productVariantModel },
        addVariant: (s, productId, dto) => this.addVariant(s, productId, dto),
        updateVariant: (s, productId, variantId, dto) => this.updateVariant(s, productId, variantId, dto),
      },
      sellerId,
      storeId,
      csvText,
    );
  }
}
