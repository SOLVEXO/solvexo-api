import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StoreAccessGuard } from '../common/guards/store-access.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { MarketPricingService } from './market-pricing.service';
import { CreateMarketPriceDto } from './dto/create-market-price.dto';
import { UpdateMarketPriceDto } from './dto/update-market-price.dto';

@ApiTags('Market Pricing')
@ApiBearerAuth()
@Controller('api/stores/:storeId/market-pricing')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, StoreAccessGuard)
@RequirePermission('products.edit_price')
export class MarketPricingController {
  constructor(private readonly marketPricingService: MarketPricingService) {}

  @Post()
  @Roles('seller', 'staff')
  @HttpCode(201)
  async create(@Param('storeId') storeId: string, @Body() dto: CreateMarketPriceDto) {
    return { success: true, data: await this.marketPricingService.create(storeId, dto) };
  }

  @Get()
  @Roles('seller', 'staff')
  async findAll(@Param('storeId') storeId: string) {
    return { success: true, data: await this.marketPricingService.findAll(storeId) };
  }

  @Get('products/:productId')
  @Roles('seller', 'staff')
  async findByProduct(@Param('storeId') storeId: string, @Param('productId') productId: string) {
    return { success: true, data: await this.marketPricingService.findByProduct(storeId, productId) };
  }

  @Get('markets/:marketId/products/:productId')
  @Roles('seller', 'staff')
  async findOne(
    @Param('storeId') storeId: string,
    @Param('marketId') marketId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId?: string,
  ) {
    return { success: true, data: await this.marketPricingService.findOne(storeId, marketId, productId, variantId) };
  }

  @Put('markets/:marketId/products/:productId')
  @Roles('seller', 'staff')
  async update(
    @Param('storeId') storeId: string,
    @Param('marketId') marketId: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateMarketPriceDto,
  ) {
    return {
      success: true,
      data: await this.marketPricingService.update(storeId, marketId, productId, dto.variantId || null, dto),
    };
  }

  @Delete('markets/:marketId/products/:productId')
  @Roles('seller', 'staff')
  @HttpCode(200)
  async remove(
    @Param('storeId') storeId: string,
    @Param('marketId') marketId: string,
    @Param('productId') productId: string,
    @Param('variantId') variantId?: string,
  ) {
    await this.marketPricingService.remove(storeId, marketId, productId, variantId);
    return { success: true, message: 'Market price deleted successfully' };
  }

  @Post('products/:productId/batch')
  @Roles('seller', 'staff')
  @HttpCode(201)
  async batchCreateForProduct(
    @Param('storeId') storeId: string,
    @Param('productId') productId: string,
    @Body() body: { basePrice: number; baseCurrency: string },
  ) {
    return {
      success: true,
      data: await this.marketPricingService.batchCreateForProduct(storeId, productId, body.basePrice, body.baseCurrency),
    };
  }
}
