/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { verifyStoreOwnershipOrForbidden } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { EntitlementsService } from '../platform-plans/entitlements.service';
import { pageOf } from '../common/paging';
import { LicensesService } from './licenses.service';

class ValidateDto {
  @IsString() @IsNotEmpty() @MaxLength(60) key: string;
  @IsOptional() @IsString() @MaxLength(200) deviceId?: string;
  @IsOptional() @IsBoolean() activate?: boolean;
}
class DeactivateDto {
  @IsString() @IsNotEmpty() @MaxLength(60) key: string;
  @IsString() @IsNotEmpty() @MaxLength(200) deviceId: string;
}
const ctxOf = (req: any) => ({ ip: String(req.ip ?? '') });

/** Public, called by the seller's software with the store API token in `x-license-token`. */
@ApiTags('License (public API)')
@Controller('api/license')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
export class LicenseApiController {
  constructor(private readonly svc: LicensesService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('validate')
  validate(@Req() req: any, @Headers('x-license-token') token: string, @Body() dto: ValidateDto) {
    return this.svc.validate(token, dto, ctxOf(req));
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('deactivate')
  deactivate(@Req() req: any, @Headers('x-license-token') token: string, @Body() dto: DeactivateDto) {
    return this.svc.deactivate(token, dto, ctxOf(req));
  }
}

@ApiTags('Licenses (buyer)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user')
@Controller('api/licenses/me')
export class BuyerLicensesController {
  constructor(private readonly svc: LicensesService) {}

  @Get()
  list(@Req() req: any, @Query('storeId') storeId: string) {
    return this.svc.listMine(resolveBuyerStoreScope(req.user.storeId, storeId), req.user.userId);
  }
}

/** Seller. Permission: licenses.manage. */
@ApiTags('Licenses (seller)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@Controller('api/licenses/store/:storeId')
export class SellerLicensesController {
  constructor(private readonly svc: LicensesService, private readonly db: DatabaseService, private readonly entitlements: EntitlementsService) {}
  private own = (req: any, storeId: string) => verifyStoreOwnershipOrForbidden(this.db.repositories.storeModel as any, storeId, actingSellerId(req.user));

  @Get() @RequirePermission('licenses.manage')
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query('page') page?: string, @Query('limit') limit?: string, @Query('status') status?: string) { await this.own(req, storeId); return this.svc.listForStore(storeId, pageOf(page, limit), status); }

  @Post('api-token') @RequirePermission('licenses.manage')
  async token(@Req() req: any, @Param('storeId') storeId: string) { await this.own(req, storeId); await this.entitlements.assertFeatureAllowed(storeId, 'digitalLicensesAllowed', 'License keys'); return this.svc.newApiToken(storeId); }

  @Post(':id/revoke') @RequirePermission('licenses.manage')
  async revoke(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.sellerRevoke(storeId, id); }

  @Post(':id/reset-activations') @RequirePermission('licenses.manage')
  async reset(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) { await this.own(req, storeId); return this.svc.sellerResetActivations(storeId, id); }
}
