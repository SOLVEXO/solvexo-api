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
import { DatabaseService } from '../database/databaseservice';
import { AppPlatformService } from './app-platform.service';

/** Solvexo admin: the app registry (register, approve, suspend, rotate secrets). */
@ApiTags('App platform (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@RequirePermission('config.manage')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/admin/app-platform')
export class AdminAppPlatformController {
  constructor(private readonly svc: AppPlatformService) {}
  private actor(req: any) { return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: 'admin' }; }
  @Get() list() { return this.svc.listApps(); }
  @Post() create(@Req() req: any, @Body() b: any) { return this.svc.createApp(this.actor(req), b); }
  @Patch(':id') update(@Param('id') id: string, @Body() b: any) { return this.svc.updateApp(id, b); }
  @Post(':id/approve') approve(@Req() req: any, @Param('id') id: string) { return this.svc.approve(this.actor(req), id); }
  @Post(':id/suspend') suspend(@Req() req: any, @Param('id') id: string) { return this.svc.suspend(this.actor(req), id); }
  @Post(':id/rotate-secrets') rotate(@Param('id') id: string) { return this.svc.rotateSecrets(id); }
}

/** Store owner: browse approved apps, give consent, open an app's page, uninstall. Permissions: apps.view / apps.manage. */
@ApiTags('App platform (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UsePipes(new ValidationPipe({ transform: false }))
@Controller('api/app-platform/:storeId')
export class SellerAppPlatformController {
  constructor(private readonly svc: AppPlatformService, private readonly db: DatabaseService) {}
  private async own(req: any, storeId: string): Promise<{ id: string; role: string }> {
    await verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));
    return { id: String(req.user.userId ?? req.user.sub ?? req.user.id ?? ''), role: String(req.user.role) };
  }
  @Get('available') @RequirePermission('apps.view')
  async available(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.listAvailable(s); }
  @Get('installed') @RequirePermission('apps.view')
  async installed(@Req() req: any, @Param('storeId') s: string) { await this.own(req, s); return this.svc.listInstalled(s); }
  @Get('authorize-preview') @RequirePermission('apps.manage')
  async preview(@Req() req: any, @Param('storeId') s: string, @Query() q: any) { await this.own(req, s); return this.svc.preview(s, q); }
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('authorize') @RequirePermission('apps.manage')
  async authorize(@Req() req: any, @Param('storeId') s: string, @Body() b: any) { return this.svc.authorize(s, await this.own(req, s), b); }
  @Delete('installs/:installId') @RequirePermission('apps.manage')
  async uninstall(@Req() req: any, @Param('storeId') s: string, @Param('installId') id: string) { return this.svc.uninstall(s, await this.own(req, s), id); }
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('installs/:installId/session-token') @RequirePermission('apps.view')
  async session(@Req() req: any, @Param('storeId') s: string, @Param('installId') id: string) { return this.svc.sessionToken(s, await this.own(req, s), id); }
}

/** The app's own server calls this (no login): authenticated by client id + secret + the single-use code. */
@ApiTags('App platform (OAuth)')
@Controller('api/app-platform/oauth')
export class AppOAuthController {
  constructor(private readonly svc: AppPlatformService) {}
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('token')
  token(@Body() body: any) { return this.svc.exchange(body); }
}
