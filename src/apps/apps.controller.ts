/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { AppsService } from './apps.service';

/**
 * Phase 8 — seller-facing App Blocks management. Same
 * `PermissionsGuard`/`actingSellerId` pattern every other staff-reachable
 * store controller in this codebase already uses; `onlinestore.content.manage`
 * is the same permission the Pages/Blog/Theme controllers gate on, since
 * installing an app / configuring its blocks is exactly that kind of
 * content-management action.
 */
@Controller('api/apps')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
export class AppsController {
  constructor(private readonly appsService: AppsService) {}

  @Get(':storeId')
  @RequirePermission('onlinestore.content.manage')
  listCatalog(@Req() req: any, @Param('storeId') storeId: string) {
    return this.appsService.listCatalogForStore(storeId, actingSellerId(req.user));
  }

  @Post(':storeId/install/:appId')
  @RequirePermission('onlinestore.content.manage')
  install(@Req() req: any, @Param('storeId') storeId: string, @Param('appId') appId: string) {
    return this.appsService.install(storeId, actingSellerId(req.user), appId);
  }

  @Delete(':storeId/uninstall/:appId')
  @RequirePermission('onlinestore.content.manage')
  uninstall(@Req() req: any, @Param('storeId') storeId: string, @Param('appId') appId: string) {
    return this.appsService.uninstall(storeId, actingSellerId(req.user), appId);
  }
}
