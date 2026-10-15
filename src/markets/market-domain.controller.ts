import { Controller, Get, Post, Body, Param, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { StoreAccessGuard } from '../common/guards/store-access.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { MarketDomainService } from './market-domain.service';

@ApiTags('Market Domains')
@ApiBearerAuth()
@Controller('api/stores/:storeId/market-domains')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, StoreAccessGuard)
@RequirePermission('settings.general.manage')
export class MarketDomainController {
  constructor(private readonly marketDomainService: MarketDomainService) {}

  @Get('resolve')
  @Roles('seller', 'staff')
  async resolveMarket(
    @Param('storeId') storeId: string,
    @Query('hostname') hostname: string,
    @Query('subfolder') subfolder?: string,
  ) {
    const result = await this.marketDomainService.resolveMarketFromUrl(storeId, hostname, subfolder);
    return { success: true, data: result };
  }

  @Get('validate-domain')
  @Roles('seller', 'staff')
  async validateDomain(
    @Param('storeId') storeId: string,
    @Query('domain') domain: string,
    @Query('excludeMarketId') excludeMarketId?: string,
  ) {
    this.marketDomainService.validateDomainFormat(domain);
    const available = await this.marketDomainService.validateDomainAvailability(storeId, domain, excludeMarketId);
    return { success: true, data: { available } };
  }

  @Get('validate-subfolder')
  @Roles('seller', 'staff')
  async validateSubfolder(
    @Param('storeId') storeId: string,
    @Query('subfolder') subfolder: string,
    @Query('excludeMarketId') excludeMarketId?: string,
  ) {
    this.marketDomainService.validateSubfolderFormat(subfolder);
    const available = await this.marketDomainService.validateSubfolderAvailability(storeId, subfolder, excludeMarketId);
    return { success: true, data: { available } };
  }

  @Get('active')
  @Roles('seller', 'staff')
  async getActiveMarkets(@Param('storeId') storeId: string) {
    return { success: true, data: await this.marketDomainService.getActiveMarketsWithDomains(storeId) };
  }

  @Post('generate-subfolder')
  @Roles('seller', 'staff')
  async generateSubfolder(@Param('storeId') storeId: string, @Body() body: { languages: string[]; countries: string[] }) {
    const subfolder = this.marketDomainService.generateDefaultSubfolder(body);
    return { success: true, data: { subfolder } };
  }
}
