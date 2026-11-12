/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
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
import { CheckoutRulesService } from './checkout-rules.service';

/** Seller side: manage and test the store's checkout rules. Permissions: checkout_rules.view / checkout_rules.manage. */
@ApiTags('Checkout rules (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/checkout-rules/:storeId')
export class CheckoutRulesController {
  constructor(private readonly svc: CheckoutRulesService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string): Promise<{ id: string; role: string }> {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }

  @Get() @RequirePermission('checkout_rules.view')
  async list(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return { rules: await this.svc.list(s), fields: this.svc.fieldCatalog() }; }
  @Post() @RequirePermission('checkout_rules.manage')
  async create(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.create(s, await this.own(req, s), b); }
  @Post('test') @RequirePermission('checkout_rules.view')
  async test(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { await this.own(req, s); return this.svc.test(s, b); }
  @Patch(':id') @RequirePermission('checkout_rules.manage')
  async update(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() b: any) { return this.svc.update(s, await this.own(req, s), id, b); }
  @Delete(':id') @RequirePermission('checkout_rules.manage')
  async remove(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string) { return this.svc.remove(s, await this.own(req, s), id); }
}

/** Buyer: what the rules do to my current cart (same evaluation as the final checkout). */
@ApiTags('Checkout rules (storefront)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/checkout-rules/storefront')
export class CheckoutRulesStorefrontController {
  constructor(private readonly svc: CheckoutRulesService) {}
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('preview')
  preview(@Req() req: any, @Query('storeId') storeId?: string) { return this.svc.previewCart(resolveBuyerStoreScope(req.user.storeId, storeId), String(req.user.userId)); }
}
