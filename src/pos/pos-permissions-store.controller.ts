/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Post, Put, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosPermissionsStoreService } from './pos-permissions-store.service';

/** G4.2 — the store's permission matrix: managers read it, the owner edits / resets it. */
@ApiTags('POS permissions')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/permissions')
export class PosPermissionsStoreController {
  constructor(private readonly svc: PosPermissionsStoreService) {}

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get(':storeId')
  get(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.get(req, s, { employee: e }); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Put(':storeId')
  update(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.update(req, s, body, { employee: e }); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Post(':storeId/reset')
  reset(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.reset(req, s, body, { employee: e }); }
}
