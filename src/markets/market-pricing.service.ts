import { Injectable, NotFoundException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { DatabaseService } from '@/database/databaseservice';
import { MarketsService } from './markets.service';
import { SetMarketPriceDto } from './dto/create-market-price.dto';

/** One fixed market price as the storefront and checkout use it. */
export interface FixedMarketPrice {
  productId: string;
  variantId: string | null;
  fixedPrice: number;
  compareAtPrice: number | null;
}

/** Key used to look a fixed price up: the variant's own price wins over the product-wide one. */
export function fixedPriceFor(
  prices: Map<string, FixedMarketPrice>,
  productId: string,
  variantId: string | null | undefined,
): FixedMarketPrice | null {
  return (variantId ? prices.get(`${productId}:${variantId}`) : undefined) ?? prices.get(`${productId}:`) ?? null;
}

/**
 * Shopify catalog fixed prices: per market, per product (or variant), in the market's currency.
 * Every write is store-scoped and only fixed prices are accepted (percentage rows from older data are ignored).
 */
@Injectable()
export class MarketPricingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly marketsService: MarketsService,
  ) {}

  private get marketPriceModel() {
    return this.databaseService.repositories.marketPriceModel;
  }

  private async loadProduct(storeId: string, productId: string, variantId?: string | null) {
    const product: any = await this.databaseService.repositories.productModel
      .findOne({ _id: productId, storeId, isDelete: false })
      .select('_id name')
      .lean();
    if (!product) throw new NotFoundException('Product not found in this store');
    if (variantId) {
      const variant = await this.databaseService.repositories.productVariantModel
        .findOne({ _id: variantId, productId: String(productId), isDelete: false })
        .select('_id')
        .lean();
      if (!variant) throw new NotFoundException('Variant not found for this product');
    }
    return product;
  }

  /** Every fixed price of one market, with product names for the seller screen. */
  async listForMarket(storeId: string, marketId: string) {
    const market: any = await this.marketsService.findOne(storeId, marketId);
    const rows: any[] = await this.marketPriceModel
      .find({ marketId: String(market._id), priceType: 'fixed', isDelete: false })
      .lean();
    const productIds = Array.from(new Set(rows.map((r) => r.productId)));
    const variantIds = rows.map((r) => r.variantId).filter(Boolean);
    const [products, variants]: [any[], any[]] = await Promise.all([
      this.databaseService.repositories.productModel
        .find({ _id: { $in: productIds }, storeId, isDelete: false }).select('name images').lean(),
      this.databaseService.repositories.productVariantModel
        .find({ _id: { $in: variantIds } }).select('options sku price').lean(),
    ]);
    const pMap = new Map(products.map((p) => [String(p._id), p]));
    const vMap = new Map(variants.map((v) => [String(v._id), v]));
    return rows
      .filter((r) => pMap.has(String(r.productId)))
      .map((r) => {
        const p = pMap.get(String(r.productId));
        const v = r.variantId ? vMap.get(String(r.variantId)) : null;
        return {
          id: String(r._id),
          productId: String(r.productId),
          variantId: r.variantId ? String(r.variantId) : null,
          productName: p?.name ?? '',
          image: p?.images?.[0] ?? null,
          variantLabel: v ? (v.options ?? []).map((o: any) => o?.value).filter(Boolean).join(' / ') || v.sku || null : null,
          fixedPrice: r.fixedPrice,
          compareAtPrice: r.compareAtPrice ?? null,
          currency: r.currency,
        };
      });
  }

  /** Fixed prices of one product across the store's markets (product page). */
  async listForProduct(storeId: string, productId: string) {
    await this.loadProduct(storeId, productId);
    const markets: any[] = await this.marketsService.findAll(storeId);
    const ids = markets.map((m) => String(m._id));
    const rows: any[] = await this.marketPriceModel
      .find({ marketId: { $in: ids }, productId, priceType: 'fixed', isDelete: false })
      .lean();
    return rows.map((r) => ({
      id: String(r._id),
      marketId: String(r.marketId),
      variantId: r.variantId ? String(r.variantId) : null,
      fixedPrice: r.fixedPrice,
      compareAtPrice: r.compareAtPrice ?? null,
      currency: r.currency,
    }));
  }

  /** Create or replace the fixed price of a product/variant in a market. */
  async upsert(storeId: string, marketId: string, dto: SetMarketPriceDto) {
    const market: any = await this.marketsService.findOne(storeId, marketId);
    await this.loadProduct(storeId, dto.productId, dto.variantId ?? null);
    const filter = {
      marketId: String(market._id),
      productId: String(dto.productId),
      variantId: dto.variantId ? String(dto.variantId) : null,
      isDelete: false,
    };
    const doc: any = await this.marketPriceModel.findOneAndUpdate(
      filter,
      {
        $set: {
          storeId,
          priceType: 'fixed',
          fixedPrice: Number(dto.fixedPrice),
          compareAtPrice: dto.compareAtPrice == null ? null : Number(dto.compareAtPrice),
          percentageAdjustment: null,
          currency: market.currency,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    return {
      id: String(doc._id),
      productId: doc.productId,
      variantId: doc.variantId,
      fixedPrice: doc.fixedPrice,
      compareAtPrice: doc.compareAtPrice ?? null,
      currency: doc.currency,
    };
  }

  async remove(storeId: string, marketId: string, priceId: string): Promise<void> {
    const market: any = await this.marketsService.findOne(storeId, marketId);
    if (!isValidObjectId(priceId)) throw new NotFoundException('Market price not found');
    const res = await this.marketPriceModel.updateOne(
      { _id: priceId, marketId: String(market._id), isDelete: false },
      { $set: { isDelete: true } },
    );
    if (!res.matchedCount) throw new NotFoundException('Market price not found');
  }

  /**
   * Fixed prices of `productIds` in a market, keyed `productId:variantId` (or `productId:` for product-wide).
   * Only rows in the market's CURRENT currency count (a currency change retires older prices).
   */
  async fixedPricesFor(marketId: string, marketCurrency: string, productIds?: string[]): Promise<Map<string, FixedMarketPrice>> {
    const filter: any = { marketId: String(marketId), priceType: 'fixed', currency: marketCurrency, isDelete: false };
    if (productIds) filter.productId = { $in: productIds.map(String) };
    const rows: any[] = await this.marketPriceModel.find(filter).select('productId variantId fixedPrice compareAtPrice').lean();
    const map = new Map<string, FixedMarketPrice>();
    for (const r of rows) {
      if (!(Number(r.fixedPrice) >= 0)) continue;
      map.set(`${r.productId}:${r.variantId ?? ''}`, {
        productId: String(r.productId),
        variantId: r.variantId ? String(r.variantId) : null,
        fixedPrice: Number(r.fixedPrice),
        compareAtPrice: r.compareAtPrice == null ? null : Number(r.compareAtPrice),
      });
    }
    return map;
  }

  /** Public list for the storefront (only active markets of the store). */
  async publicPricesForMarket(storeId: string, marketId: string): Promise<FixedMarketPrice[]> {
    if (!isValidObjectId(marketId)) throw new NotFoundException('Market not found');
    const market: any = await this.databaseService.repositories.marketModel
      .findOne({ _id: marketId, storeId, isActive: true, isDelete: false })
      .select('currency')
      .lean();
    if (!market) throw new NotFoundException('Market not found');
    return Array.from((await this.fixedPricesFor(String(market._id), market.currency)).values());
  }
}
