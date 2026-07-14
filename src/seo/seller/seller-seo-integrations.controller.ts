/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoIntegrationsService } from '../services/seo-integrations.service';
import { ConnectIntegrationDto, GetAuthUrlDto, assertValidProvider } from '../dto/connect-integration.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// Per-store GSC/Bing connection — realistically only meaningful once a store
// has its own domain to verify, hence gated behind `searchConsoleIntegrationAllowed`
// rather than being open to every plan tier.
@ApiTags('Seller SEO — Search Integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/integrations')
export class SellerSeoIntegrationsController {
  constructor(
    private readonly integrations: SeoIntegrationsService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private async assertAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    await this.entitlements.assertFeatureAllowed(storeId, 'searchConsoleIntegrationAllowed', 'Search Console / Bing Webmaster integration');
  }

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    await this.assertAccess(storeId, req.user.userId);
    return this.integrations.list({ scope: 'store', storeId });
  }

  @Get(':provider/authorize-url')
  async getAuthUrl(@Req() req: any, @Param('storeId') storeId: string, @Param('provider') provider: string, @Query() query: GetAuthUrlDto) {
    await this.assertAccess(storeId, req.user.userId);
    assertValidProvider(provider);
    return { url: this.integrations.getAuthorizationUrl(provider, query.redirectUri, storeId) };
  }

  @Post(':provider/connect')
  async connect(@Req() req: any, @Param('storeId') storeId: string, @Param('provider') provider: string, @Body() dto: ConnectIntegrationDto) {
    await this.assertAccess(storeId, req.user.userId);
    assertValidProvider(provider);
    return this.integrations.connect(
      { scope: 'store', storeId, sellerId: req.user.userId },
      provider, dto.code, dto.redirectUri, dto.siteIdentifier,
      { id: req.user.userId, role: req.user.role },
    );
  }

  @Delete(':provider')
  async disconnect(@Req() req: any, @Param('storeId') storeId: string, @Param('provider') provider: string) {
    await this.assertAccess(storeId, req.user.userId);
    assertValidProvider(provider);
    return this.integrations.disconnect({ scope: 'store', storeId }, provider, { id: req.user.userId, role: req.user.role });
  }
}
