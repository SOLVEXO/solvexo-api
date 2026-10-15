import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StoreAccessGuard } from '../common/guards/store-access.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { MarketsService } from './markets.service';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';

@ApiTags('Markets')
@ApiBearerAuth()
@Controller('api/stores/:storeId/markets')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, StoreAccessGuard)
@RequirePermission('settings.general.manage')
export class MarketsController {
  constructor(private readonly marketsService: MarketsService) {}

  @Post()
  @Roles('seller', 'staff')
  @HttpCode(201)
  async create(@Param('storeId') storeId: string, @Body() dto: CreateMarketDto) {
    return { success: true, data: await this.marketsService.create(storeId, dto) };
  }

  @Get()
  @Roles('seller', 'staff')
  async findAll(@Param('storeId') storeId: string) {
    return { success: true, data: await this.marketsService.findAll(storeId) };
  }

  @Get('primary')
  @Roles('seller', 'staff')
  async getPrimary(@Param('storeId') storeId: string) {
    return { success: true, data: await this.marketsService.getPrimaryMarket(storeId) };
  }

  @Get('resolve/:countryCode')
  @Roles('seller', 'staff')
  async resolveForCountry(@Param('storeId') storeId: string, @Param('countryCode') countryCode: string) {
    return { success: true, data: await this.marketsService.getMarketForCountry(storeId, countryCode) };
  }

  @Get(':marketId')
  @Roles('seller', 'staff')
  async findOne(@Param('storeId') storeId: string, @Param('marketId') marketId: string) {
    return { success: true, data: await this.marketsService.findOne(storeId, marketId) };
  }

  @Put(':marketId')
  @Roles('seller', 'staff')
  async update(
    @Param('storeId') storeId: string,
    @Param('marketId') marketId: string,
    @Body() dto: UpdateMarketDto,
  ) {
    return { success: true, data: await this.marketsService.update(storeId, marketId, dto) };
  }

  @Delete(':marketId')
  @Roles('seller', 'staff')
  @HttpCode(200)
  async remove(@Param('storeId') storeId: string, @Param('marketId') marketId: string) {
    await this.marketsService.remove(storeId, marketId);
    return { success: true, message: 'Market deleted successfully' };
  }
}
