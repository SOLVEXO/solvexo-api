/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreIntegrationsService } from './store-integrations.service';
import { STORE_INTEGRATION_PROVIDERS, STORE_INTEGRATION_TYPES, StoreIntegrationProvider, StoreIntegrationType } from './schemas/store-integration.schema';

/**
 * Seller-facing management API for this store's payment/WhatsApp
 * integrations — same guard + ownership-check shape as
 * `SellerSeoIntegrationsController`, this module's direct template (see the
 * Phase 1 audit and Phase 2 design doc §2). `storeId` is a route param but
 * is never trusted on its own — every method re-verifies `store.sellerId ===
 * req.user.userId` server-side before touching anything.
 *
 * Gated on `settings.payments.manage` — the real Store Settings "Manage
 * payments settings" permission (which checkout payment providers are
 * configured/enabled), split out from Finance's `finance.payments.manage`
 * (the seller's own Stripe Connect payout account, see
 * StripeConnectController) after a review confirmed Shopify treats these as
 * two distinct permissions. Still covers every integration TYPE
 * (payment/whatsapp/tax/shipping), not only payment providers, since this
 * one generic `:type/:provider` route has no way to split by type at the
 * route level — a disclosed, smaller simplification independent of the
 * payments-vs-payouts split above.
 */
@ApiTags('Seller Integrations')
@ApiBearerAuth('accessToken')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.payments.manage')
@Controller('api/store/:storeId/integrations')
export class SellerIntegrationsController {
  constructor(private readonly service: StoreIntegrationsService) {}

  @Get()
  list(@Param('storeId') storeId: string, @Req() req: any) {
    return this.service.list(storeId, actingSellerId(req.user));
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
    return this.service.connect(storeId, actingSellerId(req.user), type as StoreIntegrationType, provider as StoreIntegrationProvider, body ?? {});
  }

  @Post(':id/test')
  test(@Param('storeId') storeId: string, @Param('id') id: string, @Req() req: any) {
    return this.service.test(storeId, actingSellerId(req.user), id);
  }

  @Patch(':id')
  update(
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Body() body: { isEnabledForCheckout?: boolean; displayName?: string; webhookSecret?: string },
    @Req() req: any,
  ) {
    return this.service.update(storeId, actingSellerId(req.user), id, body ?? {});
  }

  @Delete(':id')
  disconnect(@Param('storeId') storeId: string, @Param('id') id: string, @Req() req: any) {
    return this.service.disconnect(storeId, actingSellerId(req.user), id);
  }
}
