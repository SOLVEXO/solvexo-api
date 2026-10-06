/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PlatformAddonsService } from './platform-addons.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PurchaseAddonDto } from './dto/purchase-addon.dto';

@ApiTags('Platform Plans — Add-ons')
@Controller('api/platform-plans')
export class PlatformAddonsController {
  constructor(private readonly addonsService: PlatformAddonsService) {}

  // Static "admin/addons" registered before the parameterized ":storeId/addons"
  // routes below — otherwise "admin" would be matched as a :storeId value.
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('admin/addons')
  adminListAddons(@Query() query: any) {
    return this.addonsService.adminListAddonPurchases(query);
  }

  // Static route — also registered before ":storeId/addons".
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('addons/catalog')
  getAddonCatalog() {
    return this.addonsService.getAddonCatalog();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post(':storeId/addons')
  purchaseAddon(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PurchaseAddonDto) {
    return this.addonsService.purchaseAddon(req.user.userId, storeId, dto);
  }

  @ApiBearerAuth()
  // Read-only: staff holding billing view may see add-on purchases (PermissionsGuard pins staff to their own :storeId).
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view', 'settings.billing.manage')
  @Get(':storeId/addons')
  listAddons(@Req() req: any, @Param('storeId') storeId: string) {
    return this.addonsService.listAddons(actingSellerId(req.user), storeId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @Delete(':storeId/addons/:addonId')
  cancelAddon(@Req() req: any, @Param('storeId') storeId: string, @Param('addonId') addonId: string) {
    return this.addonsService.cancelAddon(req.user.userId, storeId, addonId);
  }
}
