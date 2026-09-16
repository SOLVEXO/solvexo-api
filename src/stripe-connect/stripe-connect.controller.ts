/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
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
// Disclosed limitation: Stripe Connect is a per-SELLER account (not
// per-store — no `:storeId` route param exists here at all), so
// `PermissionsGuard`'s storeId-pinning check is a no-op for this
// controller. A staff member granted `finance.payments.manage` at ANY one
// store can see/manage the seller's single Connect account, which may also
// power other stores that same seller owns — a pre-existing architectural
// property of Stripe Connect in this codebase (see CLAUDE.md), not
// something introduced by staff-permission gating.
@ApiTags('Stripe Connect')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('finance.payments.manage')
@Controller('api/stripe-connect')
export class StripeConnectController {
  constructor(private readonly stripeConnectService: StripeConnectService) {}

  @Get('status')
  getStatus(@Req() req: any) {
    return this.stripeConnectService.getStatus(actingSellerId(req.user));
  }

  @Post('onboarding-link')
  createOnboardingLink(@Req() req: any, @Body() dto: CreateOnboardingLinkDto) {
    return this.stripeConnectService.createOnboardingLink(actingSellerId(req.user), dto.refreshUrl, dto.returnUrl);
  }

  @Post('sync')
  sync(@Req() req: any) {
    return this.stripeConnectService.syncAccountStatus(actingSellerId(req.user));
  }
}
