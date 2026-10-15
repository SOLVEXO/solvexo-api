import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Market, MarketDocument } from './schemas/market.schema';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { DatabaseService } from '@/database/databaseservice';
import { AdminConfigService } from '@/admin-config/admin-config.service';
import { pickMarketForCountry } from './market-price.util';

@Injectable()
export class MarketsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly adminConfigService: AdminConfigService,
  ) {}

  private get marketModel() {
    return this.databaseService.repositories.marketModel;
  }

  async create(storeId: string, dto: CreateMarketDto): Promise<Market> {
    // Validate that the store exists
    const store = await this.databaseService.repositories.storeModel.findById(storeId);
    if (!store) {
      throw new NotFoundException('Store not found');
    }

    // Ensure only one primary market per store
    if (dto.isPrimary) {
      await this.marketModel.updateMany(
        { storeId, isPrimary: true, isDelete: false },
        { isPrimary: false },
      );
    }

    // Validate currency is enabled on platform
    const enabledCurrencies = await this.adminConfigService.getEnabledCurrencies();
    const enabledCurrencyCodes = enabledCurrencies.map((c) => c.code);
    if (!enabledCurrencyCodes.includes(dto.currency)) {
      throw new BadRequestException(`Currency ${dto.currency} is not enabled on this platform`);
    }

    const market = await this.marketModel.create({
      ...dto,
      storeId,
    });

    return market;
  }

  async findAll(storeId: string): Promise<Market[]> {
    return this.marketModel.find({ storeId, isDelete: false }).sort({ isPrimary: -1, name: 1 }).lean();
  }

  async findOne(storeId: string, marketId: string): Promise<Market> {
    const market = await this.marketModel.findOne({ _id: marketId, storeId, isDelete: false });
    if (!market) {
      throw new NotFoundException('Market not found');
    }
    return market;
  }

  async update(storeId: string, marketId: string, dto: UpdateMarketDto): Promise<Market> {
    // Verify market exists and belongs to store
    const existing = await this.marketModel.findOne({ _id: marketId, storeId, isDelete: false });
    if (!existing) {
      throw new NotFoundException('Market not found');
    }

    // If setting as primary, ensure no other primary market exists
    if (dto.isPrimary) {
      await this.marketModel.updateMany(
        { storeId, isPrimary: true, isDelete: false, _id: { $ne: marketId } },
        { isPrimary: false },
      );
    }

    // Validate currency if being changed
    if (dto.currency && dto.currency !== existing.currency) {
      const enabledCurrencies = await this.adminConfigService.getEnabledCurrencies();
      const enabledCurrencyCodes = enabledCurrencies.map((c) => c.code);
      if (!enabledCurrencyCodes.includes(dto.currency)) {
        throw new BadRequestException(`Currency ${dto.currency} is not enabled on this platform`);
      }
    }

    const updated = await this.marketModel.findOneAndUpdate(
      { _id: marketId, storeId, isDelete: false },
      { $set: dto },
      { new: true },
    );

    return updated as Market;
  }

  async remove(storeId: string, marketId: string): Promise<void> {
    const market = await this.marketModel.findOne({ _id: marketId, storeId, isDelete: false });
    if (!market) {
      throw new NotFoundException('Market not found');
    }
    // Soft delete
    await this.marketModel.updateOne({ _id: marketId }, { isDelete: true });
  }

  async getPrimaryMarket(storeId: string): Promise<Market | null> {
    return this.marketModel.findOne({ storeId, isPrimary: true, isDelete: false }).lean();
  }

  /** The market a buyer from `countryCode` shops in: a market listing the country, else the primary one. */
  async getMarketForCountry(storeId: string, countryCode: string | null | undefined): Promise<Market | null> {
    const markets = await this.marketModel.find({ storeId, isActive: true, isDelete: false }).lean();
    return pickMarketForCountry(markets as any[], countryCode) as Market | null;
  }

  /** What the storefront may know about a store's markets (no internal fields). */
  async getPublicMarkets(storeId: string) {
    const markets: any[] = await this.marketModel
      .find({ storeId, isActive: true, isDelete: false })
      .sort({ isPrimary: -1, name: 1 })
      .lean();
    const languages = Array.from(new Set(['en', ...markets.flatMap((m) => (m.languages ?? []).map((l: string) => String(l).toLowerCase()))]));
    return {
      defaultLanguage: 'en',
      languages,
      markets: markets.map((m) => ({
        id: String(m._id),
        name: m.name,
        countries: m.countries ?? [],
        currency: m.currency,
        languages: m.languages ?? [],
        isPrimary: !!m.isPrimary,
        subfolder: m.subfolder ?? null,
        domain: m.domain ?? null,
        pricingRule: {
          type: m.pricingRule?.type ?? 'auto',
          percentageAdjustment: m.pricingRule?.percentageAdjustment ?? null,
          useRounding: !!m.pricingRule?.useRounding,
          roundingRule: m.pricingRule?.roundingRule ?? 'nearest',
          conversionFee: m.pricingRule?.conversionFee ?? null,
        },
      })),
    };
  }

  /**
   * Get the pricing rule for a market.
   */
  async getMarketPricingRule(storeId: string, marketId: string): Promise<any> {
    const market = await this.findOne(storeId, marketId);
    return market.pricingRule;
  }
}
