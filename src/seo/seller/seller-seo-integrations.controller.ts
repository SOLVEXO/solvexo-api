/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { SeoIntegrationsService } from '../services/seo-integrations.service';
import { ConnectIntegrationDto, GetAuthUrlDto, assertValidProvider } from '../dto/connect-integration.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// Per-store GSC/Bing connection — realistically only meaningful once a store
// has its own domain to verify, hence gated behind `searchConsoleIntegrationAllowed`
// rather than being open to every plan tier.
@ApiTags('Seller SEO — Search Integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
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

  @RequirePermission('seo.view', 'seo.manage')
  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.integrations.list({ scope: 'store', storeId });
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get(':provider/authorize-url')
  async getAuthUrl(@Req() req: any, @Param('storeId') storeId: string, @Param('provider') provider: string, @Query() query: GetAuthUrlDto) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    assertValidProvider(provider);
    return { url: this.integrations.getAuthorizationUrl(provider, query.redirectUri, storeId) };
  }

  @RequirePermission('seo.manage')
  @Post(':provider/connect')
  async connect(@Req() req: any, @Param('storeId') storeId: string, @Param('provider') provider: string, @Body() dto: ConnectIntegrationDto) {
    const sellerId = actingSellerId(req.user);
    await this.assertAccess(storeId, sellerId);
    assertValidProvider(provider);
    return this.integrations.connect(
      { scope: 'store', storeId, sellerId },
      provider, dto.code, dto.redirectUri, dto.siteIdentifier,
      { id: req.user.userId, role: req.user.role },
    );
  }

  @RequirePermission('seo.manage')
  @Delete(':provider')
  async disconnect(@Req() req: any, @Param('storeId') storeId: string, @Param('provider') provider: string) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    assertValidProvider(provider);
    return this.integrations.disconnect({ scope: 'store', storeId }, provider, { id: req.user.userId, role: req.user.role });
  }
}
