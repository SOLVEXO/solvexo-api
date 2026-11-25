/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosApiKeysService } from './pos-api-keys.service';

/** G5.7 — the owner's store API keys (read-only scopes; the secret is shown once). */
@ApiTags('POS API keys')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/api-keys')
export class PosApiKeysController {
  constructor(private readonly svc: PosApiKeysService) {}
  private t = (e?: string) => ({ employee: e });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get(':storeId')
  list(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.list(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post(':storeId')
  create(@Req() req: any, @Param('storeId') s: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.create(req, s, b, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Post(':storeId/:keyId/revoke')
  revoke(@Req() req: any, @Param('storeId') s: string, @Param('keyId') k: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.revoke(req, s, k, this.t(e)); }
}
