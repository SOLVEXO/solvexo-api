/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AbandonedCartService } from './abandoned-cart.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { UpdateAbandonedCartSettingsDto } from './dto/update-abandoned-cart-settings.dto';

const PLATFORM_ORIGIN = 'https://solvexo.store';

@ApiTags('Abandoned Cart')
@Controller('api/abandoned-cart')
export class AbandonedCartController {
  constructor(private readonly abandonedCartService: AbandonedCartService) {}

  // ── Seller-facing ─────────────────────────────────────────────────────────

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.abandoned_checkouts')
  @Get(':storeId/settings')
  getSettings(@Req() req: any, @Param('storeId') storeId: string) {
    return this.abandonedCartService.getSettings(actingSellerId(req.user), storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.abandoned_checkouts')
  @Patch(':storeId/settings')
  updateSettings(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateAbandonedCartSettingsDto) {
    return this.abandonedCartService.updateSettings(actingSellerId(req.user), storeId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.abandoned_checkouts')
  @Get(':storeId/stats')
  getStats(@Req() req: any, @Param('storeId') storeId: string) {
    return this.abandonedCartService.getStats(actingSellerId(req.user), storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('orders.abandoned_checkouts')
  @Get(':storeId')
  listAbandoned(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.abandonedCartService.listAbandoned(actingSellerId(req.user), storeId, query);
  }

  // ── Public — the link embedded in the recovery email ────────────────────

  /** No auth — the whole point is a buyer clicking a link straight out of
   *  their inbox. Records the click, then sends them on to their real cart. */
  @Get('click/:token')
  async trackClick(@Param('token') token: string, @Res() res: Response) {
    await this.abandonedCartService.trackClick(token);
    return res.redirect(302, `${PLATFORM_ORIGIN}/cart`);
  }
}
