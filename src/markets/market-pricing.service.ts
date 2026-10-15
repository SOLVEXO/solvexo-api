import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketPrice, MarketPriceDocument } from './schemas/market-price.schema';
import { CreateMarketPriceDto } from './dto/create-market-price.dto';
import { UpdateMarketPriceDto } from './dto/update-market-price.dto';
import { DatabaseService } from '@/database/databaseservice';
import { MarketsService } from './markets.service';
import { ExchangeRateService } from '@/exchange-rate/exchange-rate.service';
import { calculateFinalPrice, getDefaultRoundingRule } from '@/common/rounding-rules.const';

@Injectable()
export class MarketPricingService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly marketsService: MarketsService,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  private get marketPriceModel() {
    return this.databaseService.repositories.marketPriceModel;
  }

  /** A market price may only point at a live product of the SAME store (a seller must never price another store's product). */
  private async assertProductInStore(storeId: string, productId: string): Promise<void> {
    const product = await this.databaseService.repositories.productModel
      .findOne({ _id: productId, storeId, isDelete: false })
      .select('_id')
      .lean();
    if (!product) throw new NotFoundException('Product not found in this store');
  }

  /**
   * Create a market-specific price for a product/variant.
   */
  async create(storeId: string, dto: CreateMarketPriceDto): Promise<MarketPrice> {
    // Verify market belongs to store
    const market = await this.marketsService.findOne(storeId, dto.marketId);
    await this.assertProductInStore(storeId, dto.productId);

    // Validate currency matches market currency
    if (dto.currency !== market.currency) {
      throw new BadRequestException(`Price currency ${dto.currency} must match market currency ${market.currency}`);
    }

    // Validate pricing type has required fields
    if (dto.priceType === 'percentage' && dto.percentageAdjustment === null) {
      throw new BadRequestException('percentageAdjustment is required when priceType is percentage');
    }

    if (dto.priceType === 'fixed' && dto.fixedPrice === null) {
      throw new BadRequestException('fixedPrice is required when priceType is fixed');
    }

    // Check for existing pricing (soft-deleted entries are ignored)
    const existing = await this.marketPriceModel.findOne({
      marketId: dto.marketId,
      productId: dto.productId,
      variantId: dto.variantId || null,
      isDelete: false,
    });

    if (existing) {
      throw new BadRequestException('Market pricing already exists for this product/variant');
    }

    const marketPrice = await this.marketPriceModel.create(dto);
    return marketPrice;
  }

  /**
   * Get all market prices for a store's products.
   */
  async findAll(storeId: string): Promise<MarketPrice[]> {
    // Get all markets for this store
    const markets = await this.marketsService.findAll(storeId);
    const marketIds = markets.map((m) => (m as any)._id?.toString());

    return this.marketPriceModel
      .find({ marketId: { $in: marketIds }, isDelete: false })
      .lean();
  }

  /**
   * Get market prices for a specific product.
   */
  async findByProduct(storeId: string, productId: string): Promise<MarketPrice[]> {
    const markets = await this.marketsService.findAll(storeId);
    const marketIds = markets.map((m) => (m as any)._id?.toString());

    return this.marketPriceModel
      .find({ marketId: { $in: marketIds }, productId, isDelete: false })
      .lean();
  }

  /**
   * Get market price for a specific product/variant in a market.
   */
  async findOne(storeId: string, marketId: string, productId: string, variantId?: string | null): Promise<MarketPrice> {
    const market = await this.marketsService.findOne(storeId, marketId);

    const marketPrice = await this.marketPriceModel.findOne({
      marketId,
      productId,
      variantId: variantId || null,
      isDelete: false,
    });

    if (!marketPrice) {
      throw new NotFoundException('Market price not found');
    }

    return marketPrice;
  }

  /**
   * Update a market price.
   */
  async update(storeId: string, marketId: string, productId: string, variantId: string | null, dto: UpdateMarketPriceDto): Promise<MarketPrice> {
    await this.marketsService.findOne(storeId, marketId);
    await this.assertProductInStore(storeId, productId);
    const existing = await this.marketPriceModel.findOne({
      marketId,
      productId,
      variantId: variantId || null,
      isDelete: false,
    });

    if (!existing) {
      throw new NotFoundException('Market price not found');
    }

    // If changing currency, validate against market
    if (dto.currency && dto.currency !== existing.currency) {
      const market = await this.marketsService.findOne(storeId, marketId);
      if (dto.currency !== market.currency) {
        throw new BadRequestException(`Price currency ${dto.currency} must match market currency ${market.currency}`);
      }
    }

    // Validate pricing type has required fields
    if (dto.priceType === 'percentage' && dto.percentageAdjustment === null) {
      throw new BadRequestException('percentageAdjustment is required when priceType is percentage');
    }

    if (dto.priceType === 'fixed' && dto.fixedPrice === null) {
      throw new BadRequestException('fixedPrice is required when priceType is fixed');
    }

    const updated = await this.marketPriceModel.findOneAndUpdate(
      { marketId, productId, variantId: variantId || null, isDelete: false },
      { $set: dto },
      { new: true },
    );

    return updated as MarketPrice;
  }

  /**
   * Delete a market price (soft delete).
   */
  async remove(storeId: string, marketId: string, productId: string, variantId?: string | null): Promise<void> {
    await this.marketsService.findOne(storeId, marketId);
    await this.assertProductInStore(storeId, productId);
    const existing = await this.marketPriceModel.findOne({
      marketId,
      productId,
      variantId: variantId || null,
      isDelete: false,
    });

    if (!existing) {
      throw new NotFoundException('Market price not found');
    }

    await this.marketPriceModel.updateOne(
      { marketId, productId, variantId: variantId || null },
      { isDelete: true },
    );
  }

  /**
   * Calculate the price for a product in a specific market.
   * Uses market-specific pricing if available, otherwise converts base price using FX.
   * Applies market's rounding rules and conversion fee if configured.
   *
   * @param basePrice - Product price in store base currency
   * @param baseCurrency - Store base currency
   * @param marketCurrency - Market currency
   * @param marketPricing - Optional market-specific pricing
   * @param marketPricingRule - Optional market pricing rule (rounding, conversion fee)
   * @returns Price in market currency
   */
  async calculatePrice(
    basePrice: number,
    baseCurrency: string,
    marketCurrency: string,
    marketPricing?: MarketPrice | null,
    marketPricingRule?: { useRounding?: boolean; roundingRule?: string; conversionFee?: number } | null,
  ): Promise<number> {
    // If market has fixed pricing, use it directly
    if (marketPricing && marketPricing.priceType === 'fixed' && marketPricing.fixedPrice !== null) {
      let price = marketPricing.fixedPrice;

      // Apply conversion fee if configured
      if (marketPricingRule?.conversionFee) {
        price = price * (1 + marketPricingRule.conversionFee / 100);
      }

      // Apply rounding if configured
      if (marketPricingRule?.useRounding && marketPricingRule.roundingRule) {
        price = calculateFinalPrice(price, marketCurrency, null, marketPricingRule.roundingRule as any);
      }

      return price;
    }

    // If market has percentage adjustment, apply it to converted price
    let price = basePrice;

    // Convert base price to market currency using USD as pivot
    if (baseCurrency !== marketCurrency) {
      const baseRate = await this.exchangeRateService.getCurrentRate(baseCurrency);
      const marketRate = await this.exchangeRateService.getCurrentRate(marketCurrency);

      if (!baseRate && baseCurrency !== 'USD') {
        throw new BadRequestException(`Exchange rate not available for ${baseCurrency}`);
      }
      if (!marketRate && marketCurrency !== 'USD') {
        throw new BadRequestException(`Exchange rate not available for ${marketCurrency}`);
      }

      // Convert: baseCurrency -> USD -> marketCurrency
      const baseToUsd = baseCurrency === 'USD' ? 1 : baseRate!.ratePerUSD;
      const usdToMarket = marketCurrency === 'USD' ? 1 : marketRate!.ratePerUSD;
      price = basePrice / baseToUsd * usdToMarket;
    }

    // Apply percentage adjustment if available
    if (marketPricing && marketPricing.priceType === 'percentage' && marketPricing.percentageAdjustment !== null) {
      const adjustment = price * (marketPricing.percentageAdjustment / 100);
      price = price + adjustment;
    }

    // Apply conversion fee if configured
    if (marketPricingRule?.conversionFee) {
      price = price * (1 + marketPricingRule.conversionFee / 100);
    }

    // Apply rounding if configured
    if (marketPricingRule?.useRounding) {
      const roundingRule = marketPricingRule.roundingRule || getDefaultRoundingRule(marketCurrency);
      price = calculateFinalPrice(price, marketCurrency, null, roundingRule as any);
    }

    return price;
  }

  /**
   * Batch create market prices for all markets of a store.
   * Useful for product creation/update workflows.
   */
  async batchCreateForProduct(
    storeId: string,
    productId: string,
    basePrice: number,
    baseCurrency: string,
  ): Promise<MarketPrice[]> {
    await this.assertProductInStore(storeId, productId);
    const markets = await this.marketsService.findAll(storeId);
    const createdPrices: MarketPrice[] = [];

    for (const market of markets) {
      const marketId = (market as any)._id?.toString();

      // Skip if pricing already exists
      const existing = await this.marketPriceModel.findOne({
        marketId,
        productId,
        variantId: null,
        isDelete: false,
      });

      if (existing) {
        continue;
      }

      // Calculate price in market currency using USD as pivot
      let price = basePrice;
      if (baseCurrency !== market.currency) {
        const baseRate = await this.exchangeRateService.getCurrentRate(baseCurrency);
        const marketRate = await this.exchangeRateService.getCurrentRate(market.currency);

        if (baseRate && marketRate) {
          const baseToUsd = baseCurrency === 'USD' ? 1 : baseRate.ratePerUSD;
          const usdToMarket = market.currency === 'USD' ? 1 : marketRate.ratePerUSD;
          price = basePrice / baseToUsd * usdToMarket;
        }
      }

      // Create auto pricing entry
      const marketPrice = await this.marketPriceModel.create({
        marketId,
        productId,
        variantId: null,
        priceType: 'percentage',
        percentageAdjustment: 0, // No adjustment, just FX conversion
        currency: market.currency,
        fixedPrice: null,
        compareAtPrice: null,
      });

      createdPrices.push(marketPrice);
    }

    return createdPrices;
  }

  /**
   * Calculate final price for a product in a market with all market rules applied.
   * This is the main method to use at checkout time.
   *
   * @param storeId - Store ID
   * @param marketId - Market ID
   * @param productId - Product ID
   * @param basePrice - Base price in store currency
   * @param baseCurrency - Store base currency
   * @returns Final price in market currency
   */
  async calculateFinalPriceForMarket(
    storeId: string,
    marketId: string,
    productId: string,
    basePrice: number,
    baseCurrency: string,
  ): Promise<number> {
    // Get market
    const market = await this.marketsService.findOne(storeId, marketId);

    // Get market-specific pricing if exists
    const marketPricing = await this.marketPriceModel.findOne({
      marketId,
      productId,
      variantId: null,
      isDelete: false,
    });

    // Calculate price with market rules
    return this.calculatePrice(
      basePrice,
      baseCurrency,
      market.currency,
      marketPricing,
      market.pricingRule,
    );
  }
}
