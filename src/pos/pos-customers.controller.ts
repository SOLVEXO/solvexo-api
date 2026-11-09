/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosCustomersService } from './pos-customers.service';
import { UseInterceptors } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';

/** G3.3 — customers, store credit and loyalty for the till. WHO may do WHAT is the permission matrix (`pos-permissions.config.ts`). Reads stay available on a lapsed plan; writes need it. */
@ApiTags('POS customers')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/customers')
export class PosCustomersController {
  constructor(private readonly svc: PosCustomersService) {}
  private t = (e?: string, a?: string) => ({ employee: e, approver: a });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('config/:storeId')
  config(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.config(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('loyalty/:storeId')
  setLoyalty(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.setLoyaltyConfig(req, s, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('search/:storeId')
  search(@Req() req: any, @Param('storeId') s: string, @Query('q') q: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.search(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('profile/:storeId/:id')
  profile(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.profile(req, s, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('credit/:storeId/:id')
  credit(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.creditLedger(req, s, id, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('credit/:storeId/:id/adjust')
  creditAdjust(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string, @Headers('x-pos-approver-token') a?: string) { return this.svc.creditAdjust(req, s, id, body, this.t(e, a)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post(':storeId')
  create(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.create(req, s, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch(':storeId/:id')
  update(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.update(req, s, id, body, this.t(e)); }
}
