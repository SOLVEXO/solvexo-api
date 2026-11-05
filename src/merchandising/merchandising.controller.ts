/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { MerchandisingService } from './merchandising.service';

/** Seller side: reads need products.view, writes products.edit. Store-pinned for staff by PermissionsGuard. */
@ApiTags('Merchandising')
@ApiBearerAuth('accessToken')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/merchandising/:storeId')
export class MerchandisingController {
  constructor(private readonly s: MerchandisingService) {}
  private id(req: any) { return actingSellerId(req.user); }

  @Get('bundle/:productId') @RequirePermission('products.view')
  getBundle(@Req() req: any, @Param('storeId') st: string, @Param('productId') p: string) { return this.s.getBundle(st, this.id(req), p); }
  @Put('bundle/:productId') @RequirePermission('products.edit')
  setBundle(@Req() req: any, @Param('storeId') st: string, @Param('productId') p: string, @Body() b: any) { return this.s.setBundle(st, this.id(req), p, b?.components); }
  @Delete('bundle/:productId') @RequirePermission('products.edit')
  removeBundle(@Req() req: any, @Param('storeId') st: string, @Param('productId') p: string) { return this.s.removeBundle(st, this.id(req), p); }

  @Get('preorders') @RequirePermission('products.view')
  listPreorders(@Req() req: any, @Param('storeId') st: string) { return this.s.listPreorders(st, this.id(req)); }
  @Put('preorder/:variantId') @RequirePermission('products.edit')
  setPreorder(@Req() req: any, @Param('storeId') st: string, @Param('variantId') v: string, @Body() b: any) { return this.s.setPreorder(st, this.id(req), v, b?.preorder); }

  @Get('recommendations/:productId') @RequirePermission('products.view')
  getRecs(@Req() req: any, @Param('storeId') st: string, @Param('productId') p: string) { return this.s.getRecommendations(st, this.id(req), p); }
  @Put('recommendations/:productId') @RequirePermission('products.edit')
  setRecs(@Req() req: any, @Param('storeId') st: string, @Param('productId') p: string, @Body() b: any) { return this.s.setRecommendations(st, this.id(req), p, b ?? {}); }

  @Get('cart-upsell') @RequirePermission('products.view')
  getUpsell(@Req() req: any, @Param('storeId') st: string) { return this.s.getCartUpsell(st, this.id(req)); }
  @Put('cart-upsell') @RequirePermission('products.edit')
  setUpsell(@Req() req: any, @Param('storeId') st: string, @Body() b: any) { return this.s.setCartUpsell(st, this.id(req), b ?? {}); }
}

/** Public storefront reads (no auth): store-scoped, capped, throttled. */
@ApiTags('Public Merchandising')
@Controller('api/public/merchandising/:storeId')
export class PublicMerchandisingController {
  constructor(private readonly s: MerchandisingService) {}

  @Get('recommendations/:productId')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async recs(@Param('storeId') st: string, @Param('productId') p: string, @Query('limit') limit?: string, @Query('exclude') exclude?: string) {
    const items = await this.s.resolveRecommendations(st, p, { limit: parseInt(limit ?? '6', 10) || 6, excludeIds: (exclude ?? '').split(',').filter(Boolean).slice(0, 50) });
    return { success: true, data: { items } };
  }

  @Post('cart-upsell')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async cart(@Param('storeId') st: string, @Body() b: any) {
    return { success: true, data: await this.s.cartSuggestions(st, b?.productIds) };
  }
}
