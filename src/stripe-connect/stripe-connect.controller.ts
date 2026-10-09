/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { StripeConnectService } from './stripe-connect.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { CreateOnboardingLinkDto } from './dto/create-onboarding-link.dto';

// Gated on `finance.payments.manage` (Finance: "Manage other payment
// settings") deliberately, not Store Settings' `settings.payments.manage` —
// this is the seller's own Stripe Connect PAYOUT account (where their money
// goes), a Finance-scoped concern distinct from `settings.payments.manage`
// (which checkout payment providers/methods are configured, gates
// SellerIntegrationsController) — confirmed after a review of the two
// permissions found they'd been incorrectly merged onto one key. Both
// surface on the same seller-facing Integrations page, so managing Stripe
// there fully needs both permissions granted together.
//
// Stripe Connect is PER STORE (like each Shopify store's own payments account): every route carries the
// `:storeId`, the service checks the store belongs to the seller, and PermissionsGuard pins a staff caller to
// their own store — so staff can only ever touch their own store's account.
@ApiTags('Stripe Connect')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('finance.payments.manage')
@Controller('api/stripe-connect')
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  @Get(':storeId/status')
  getStatus(@Req() req: any, @Param('storeId') storeId: string) {
    return this.stripeConnectService.getStatus(actingSellerId(req.user), storeId);
  }

  // Read-only money views live on the Finance page, so they need the Finance "view payouts" permission
  // (the method-level decorator overrides the class-level manage permission).
  @Get(':storeId/payouts')
  @RequirePermission('finance.payouts.view')
  getPayouts(@Req() req: any, @Param('storeId') storeId: string) {
    return this.stripeConnectService.getPayoutOverview(actingSellerId(req.user), storeId);
  }

  @Get(':storeId/payouts/:payoutId')
  @RequirePermission('finance.payouts.view')
  getPayoutDetail(@Req() req: any, @Param('storeId') storeId: string, @Param('payoutId') payoutId: string) {
    return this.stripeConnectService.getPayoutDetail(actingSellerId(req.user), storeId, payoutId);
  }

  @Get(':storeId/balance-transactions')
  @RequirePermission('finance.payouts.view')
  getBalanceTransactions(
    @Req() req: any, @Param('storeId') storeId: string,
    @Query('limit') limit?: string, @Query('startingAfter') startingAfter?: string, @Query('type') type?: string,
  ) {
    return this.stripeConnectService.getBalanceTransactions(actingSellerId(req.user), storeId, { limit: Number(limit) || undefined, startingAfter, type });
  }

  @Post(':storeId/onboarding-link')
  createOnboardingLink(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateOnboardingLinkDto) {
    return this.stripeConnectService.createOnboardingLink(actingSellerId(req.user), storeId, dto.refreshUrl, dto.returnUrl);
  }

  @Post(':storeId/sync')
  sync(@Req() req: any, @Param('storeId') storeId: string) {
    return this.stripeConnectService.syncAccountStatus(actingSellerId(req.user), storeId);
  }
}
