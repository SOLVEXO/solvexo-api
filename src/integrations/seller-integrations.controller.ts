/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreIntegrationsService } from './store-integrations.service';
import { STORE_INTEGRATION_PROVIDERS, STORE_INTEGRATION_TYPES, StoreIntegrationProvider, StoreIntegrationType } from './schemas/store-integration.schema';

/**
 * Seller-facing management API for this store's payment/WhatsApp
 * integrations — same guard + ownership-check shape as
 * `SellerSeoIntegrationsController`, this module's direct template (see the
 * Phase 1 audit and Phase 2 design doc §2). `storeId` is a route param but
 * is never trusted on its own — every method re-verifies `store.sellerId ===
 * req.user.userId` server-side before touching anything.
 */
@ApiTags('Seller Integrations')
@ApiBearerAuth('accessToken')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store/:storeId/integrations')
export class SellerIntegrationsController {
  constructor(private readonly service: StoreIntegrationsService) {}

  @Get()
  list(@Param('storeId') storeId: string, @Req() req: any) {
    return this.service.list(storeId, req.user.userId);
  }

  @Post(':type/:provider/connect')
  connect(
    @Param('storeId') storeId: string,
    @Param('type') type: string,
    @Param('provider') provider: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    if (!STORE_INTEGRATION_TYPES.includes(type as StoreIntegrationType)) {
      throw new BadRequestException(`Unknown integration type "${type}"`);
    }
    if (!STORE_INTEGRATION_PROVIDERS.includes(provider as StoreIntegrationProvider)) {
      throw new BadRequestException(`Unknown provider "${provider}"`);
    }
    return this.service.connect(storeId, req.user.userId, type as StoreIntegrationType, provider as StoreIntegrationProvider, body ?? {});
  }

  @Post(':id/test')
  test(@Param('storeId') storeId: string, @Param('id') id: string, @Req() req: any) {
    return this.service.test(storeId, req.user.userId, id);
  }

  @Patch(':id')
  update(
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Body() body: { isEnabledForCheckout?: boolean; displayName?: string },
    @Req() req: any,
  ) {
    return this.service.update(storeId, req.user.userId, id, body ?? {});
  }

  @Delete(':id')
  disconnect(@Param('storeId') storeId: string, @Param('id') id: string, @Req() req: any) {
    return this.service.disconnect(storeId, req.user.userId, id);
  }
}
