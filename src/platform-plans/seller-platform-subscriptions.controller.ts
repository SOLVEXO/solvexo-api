/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Param, Body, Req, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';
import { EntitlementsService } from './entitlements.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { ChangePlatformPlanDto, CancelPlatformPlanDto, BillingPortalDto, ConfirmOnboardingPaymentMethodDto, SaveOnboardingDraftDto, AdminExtendSubscriptionDto, AdminAssignPlanDto, AdminUnlockOrLockDto } from './dto/subscribe-platform-plan.dto';
import { RefundInvoiceDto } from '../subscriptions/dto/refund-invoice.dto';

@ApiTags('Platform Plans — Seller')
@Controller('api/platform-plans')
export class SellerPlatformSubscriptionsController {
  constructor(
    private readonly sellerPlatformSubscriptionsService: SellerPlatformSubscriptionsService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/invoices/:invoiceId/refund')
  adminRefundInvoice(@Req() req: any, @Param('invoiceId') invoiceId: string, @Body() dto: RefundInvoiceDto) {
    return this.sellerPlatformSubscriptionsService.adminRefundInvoice(req.user.userId, invoiceId, dto.amountUSD, dto.reason);
  }

  // ── Admin manual override — real support tools (unlock/extend/assign/lock) ──
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/stores/:storeId/unlock')
  adminUnlockStore(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AdminUnlockOrLockDto) {
    return this.sellerPlatformSubscriptionsService.adminUnlockStore(req.user.userId, storeId, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/stores/:storeId/extend')
  adminExtendSubscription(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AdminExtendSubscriptionDto) {
    return this.sellerPlatformSubscriptionsService.adminExtendSubscription(req.user.userId, storeId, dto.days, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/stores/:storeId/assign-plan')
  adminAssignPlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AdminAssignPlanDto) {
    return this.sellerPlatformSubscriptionsService.adminAssignPlan(req.user.userId, storeId, dto.planId, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Post('admin/stores/:storeId/lock')
  adminLockStore(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: AdminUnlockOrLockDto) {
    return this.sellerPlatformSubscriptionsService.adminLockStore(req.user.userId, storeId, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('seller/overview')
  getSellerOverview(@Req() req: any) {
    return this.sellerPlatformSubscriptionsService.getSellerOverview(req.user.userId);
  }

  // Onboarding wizard's Payment step — no store exists yet at this point, so
  // these are literal routes declared ahead of the `:storeId` routes below
  // (same convention as every other literal-vs-param route split in this
  // codebase — a param route registered first would otherwise swallow
  // "onboarding" as if it were a storeId).
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('onboarding/setup-intent')
  createOnboardingSetupIntent(@Req() req: any) {
    return this.sellerPlatformSubscriptionsService.createOnboardingSetupIntent(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Post('onboarding/confirm-payment-method')
  confirmOnboardingPaymentMethod(@Req() req: any, @Body() dto: ConfirmOnboardingPaymentMethodDto) {
    return this.sellerPlatformSubscriptionsService.confirmOnboardingPaymentMethod(req.user.userId, dto.setupIntentId);
  }

  // Lets the onboarding wizard resume exactly where the seller left off
  // (step + form data) instead of restarting from step 1 after a
  // reload/lost connection/different device.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('onboarding/progress')
  getOnboardingProgress(@Req() req: any) {
    return this.sellerPlatformSubscriptionsService.getOnboardingProgress(req.user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Patch('onboarding/draft')
  saveOnboardingDraft(@Req() req: any, @Body() dto: SaveOnboardingDraftDto) {
    return this.sellerPlatformSubscriptionsService.saveOnboardingDraft(req.user.userId, dto.step, dto.maxReached, dto.form);
  }

  // Real Shopify-accurate split: "View billing" (read-only) vs "Manage
  // plan"/full billing control — previously every one of these 3 GET routes
  // required the SAME full-manage permission as changing plans/cancelling,
  // so a staff member could never be granted read-only visibility into
  // billing without also being able to change/cancel it.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view', 'settings.billing.manage')
  @Get(':storeId')
  getStorePlan(@Req() req: any, @Param('storeId') storeId: string) {
    return this.sellerPlatformSubscriptionsService.getStorePlan(actingSellerId(req.user), storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view', 'settings.billing.manage')
  @Get(':storeId/entitlements')
  async getEntitlements(@Req() req: any, @Param('storeId') storeId: string) {
    await this.sellerPlatformSubscriptionsService.verifyStoreOwnership(storeId, actingSellerId(req.user));
    const data = await this.entitlementsService.getEntitlementsSummary(storeId);
    return { success: true, data };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view', 'settings.billing.manage')
  @Get(':storeId/invoices')
  listInvoices(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.sellerPlatformSubscriptionsService.listInvoices(actingSellerId(req.user), storeId, query);
  }

  // Tighter than the 100/min global default specifically — a real Stripe
  // charge/subscription mutation, never meant to be scriptable at scale.
  // Admin routes are deliberately left off this tighter limit (see spec
  // above the admin section) — this only covers a seller/staff's own
  // self-serve billing actions.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.manage')
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Patch(':storeId/change-plan')
  changePlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ChangePlatformPlanDto) {
    return this.sellerPlatformSubscriptionsService.changePlan(actingSellerId(req.user), storeId, dto, req.headers['idempotency-key']);
  }

  /** Dry-run of change-plan's exact proration math — what the "confirm your plan change" modal shows before the seller commits. */
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.manage')
  @Post(':storeId/preview-change-plan')
  previewChangePlan(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: ChangePlatformPlanDto) {
    return this.sellerPlatformSubscriptionsService.previewChangePlan(actingSellerId(req.user), storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.manage')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':storeId/cancel')
  cancelSubscription(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CancelPlatformPlanDto) {
    return this.sellerPlatformSubscriptionsService.cancelSubscription(actingSellerId(req.user), storeId, dto.reason);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.manage')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':storeId/reactivate')
  reactivateSubscription(@Req() req: any, @Param('storeId') storeId: string) {
    return this.sellerPlatformSubscriptionsService.reactivateSubscription(actingSellerId(req.user), storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.manage')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':storeId/billing-portal')
  createBillingPortalSession(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BillingPortalDto) {
    return this.sellerPlatformSubscriptionsService.createBillingPortalSession(actingSellerId(req.user), storeId, dto.returnUrl);
  }
}
