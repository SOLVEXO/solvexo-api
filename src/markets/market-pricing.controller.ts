import { Controller, Get, Put, Delete, Body, Param, UseGuards, HttpCode, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StoreAccessGuard } from '../common/guards/store-access.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { MarketPricingService } from './market-pricing.service';
import { SetMarketPriceDto } from './dto/create-market-price.dto';

/** Shopify catalog fixed prices per market (Settings > Markets > a market > Products & prices). */
@ApiTags('Market Pricing')
@ApiBearerAuth()
@Controller('api/stores/:storeId/market-pricing')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, StoreAccessGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@RequirePermission('products.edit_price')
export class MarketPricingController {
  constructor(private readonly marketPricingService: MarketPricingService) {}

  @Get('markets/:marketId')
  @Roles('seller', 'staff')
  async listForMarket(@Param('storeId') storeId: string, @Param('marketId') marketId: string) {
    return { success: true, data: await this.marketPricingService.listForMarket(storeId, marketId) };
  }

  @Get('products/:productId')
  @Roles('seller', 'staff')
  async listForProduct(@Param('storeId') storeId: string, @Param('productId') productId: string) {
    return { success: true, data: await this.marketPricingService.listForProduct(storeId, productId) };
  }

  @Put('markets/:marketId/prices')
  @Roles('seller', 'staff')
  async upsert(@Param('storeId') storeId: string, @Param('marketId') marketId: string, @Body() dto: SetMarketPriceDto) {
    return { success: true, data: await this.marketPricingService.upsert(storeId, marketId, dto) };
  }

  @Delete('markets/:marketId/prices/:priceId')
  @Roles('seller', 'staff')
  @HttpCode(200)
  async remove(@Param('storeId') storeId: string, @Param('marketId') marketId: string, @Param('priceId') priceId: string) {
    await this.marketPricingService.remove(storeId, marketId, priceId);
    return { success: true, message: 'Market price removed' };
  }
}
