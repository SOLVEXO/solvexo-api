/* eslint-disable prettier/prettier */
import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { DatabaseService } from '../database/databaseservice';
import { PUBLIC_BROWSE_LIMIT } from '../storefront/public-throttle';
import { SellingPlansService } from './selling-plans.service';

/** Seller side: subscription plans, contracts, upcoming renewals, report. Permissions: product_subscriptions.view / .manage. */
@ApiTags('Subscriptions (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/selling-plans/:storeId')
export class SellingPlansController {
  constructor(private readonly svc: SellingPlansService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string): Promise<{ id: string; role: string }> {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  @Get('groups') @RequirePermission('product_subscriptions.view')
  async groups(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.listGroups(s); }
  @Post('groups') @RequirePermission('product_subscriptions.manage')
  async createGroup(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.createGroup(s, await this.own(req, s), b); }
  @Patch('groups/:id') @RequirePermission('product_subscriptions.manage')
  async updateGroup(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.updateGroup(s, await this.own(req, s), id, b); }

  @Get('contracts') @RequirePermission('product_subscriptions.view')
  async contracts(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.listContracts(s, q); }
  @Get('upcoming') @RequirePermission('product_subscriptions.view')
  async upcoming(@Req() req: any, @Param('storeId') s: string, @Query('days') days?: string) { await this.own(req, s); return this.svc.upcoming(s, parseInt(String(days ?? '14'), 10) || 14); }
  @Get('report') @RequirePermission('product_subscriptions.view')
  async report(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.report(s); }
  @Post('contracts/:id/:action') @RequirePermission('product_subscriptions.manage')
  async action(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Param('action') action: string) { return this.svc.sellerAction(s, await this.own(req, s), id, action); }
}

/** Buyer side: subscribe on a product page, manage my subscriptions. Store scope comes from the login, never the body alone. */
@ApiTags('Subscriptions (storefront)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/subscriptions/storefront')
export class SubscriptionsStorefrontController {
  constructor(private readonly svc: SellingPlansService) {}
  @Get('mine')
  mine(@Req() req: any, @Query('storeId') storeId?: string) { return this.svc.mine(resolveBuyerStoreScope(req.user.storeId, storeId), String(req.user.userId)); }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('subscribe')
  subscribe(@Req() req: any, @Body() body: any) { return this.svc.subscribe(resolveBuyerStoreScope(req.user.storeId, body?.storeId), String(req.user.userId), body); }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/:action')
  act(@Req() req: any, @Param('id') id: string, @Param('action') action: string, @Body() body: any) {
    return this.svc.buyerAction(resolveBuyerStoreScope(req.user.storeId, body?.storeId), String(req.user.userId), id, action, body ?? {});
  }
}

/** Public: which plans a product can be bought on (used by the product page). Behind the password-store gate. */
@ApiTags('Subscriptions (public)')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/selling-plans')
export class PublicSellingPlansController {
  constructor(private readonly svc: SellingPlansService, private readonly db: DatabaseService) {}
  @Get(':storeId')
  async plans(@Param('storeId') storeId: string, @Query('productId') productId: string, @Query('variantId') variantId?: string) {
    const store: any = await this.db.repositories.storeModel.findOne({ _id: storeId, isDelete: false }).select('_id').lean();
    if (!store) throw new NotFoundException('Store not found');
    return this.svc.plansFor(storeId, String(productId ?? ''), variantId ? String(variantId) : undefined);
  }
}
