import { BadRequestException, Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { isValidObjectId } from 'mongoose';
import { MarketsService } from './markets.service';
import { MarketPricingService } from './market-pricing.service';

/** What a storefront needs to resolve its visitor's market (country -> currency, languages, price rule). No auth. */
@ApiTags('Markets (public)')
@Controller('api/public/store-markets')
export class PublicMarketsController {
  constructor(
    private readonly marketsService: MarketsService,
    private readonly marketPricingService: MarketPricingService,
  ) {}

  @Get(':storeId')
  async getForStore(@Param('storeId') storeId: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid store id');
    return { success: true, data: await this.marketsService.getPublicMarkets(storeId) };
  }

  /** Fixed catalog prices of one market, so the storefront shows exactly what checkout charges. */
  @Get(':storeId/:marketId/prices')
  async getPrices(@Param('storeId') storeId: string, @Param('marketId') marketId: string) {
    if (!isValidObjectId(storeId)) throw new BadRequestException('Invalid store id');
    return { success: true, data: await this.marketPricingService.publicPricesForMarket(storeId, marketId) };
  }
}
