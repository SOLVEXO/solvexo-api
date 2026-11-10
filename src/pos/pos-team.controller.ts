/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosTeamService } from './pos-team.service';

/** G3.6 — team: attendance (clock in / out, breaks by PIN), corrections, anomaly review, roster and the attendance report. WHO may do WHAT is the permission matrix. */
@ApiTags('POS team')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/team')
export class PosTeamController {
  constructor(private readonly svc: PosTeamService) {}
  private t = (e?: string) => ({ employee: e });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('me/:storeId')
  me(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.me(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('clock/:storeId')
  clock(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.clock(req, s, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('records/:storeId')
  records(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.records(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('anomalies/:storeId')
  anomalies(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.anomalies(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('anomalies/:storeId/ack')
  ack(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.ack(req, s, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('corrections/:storeId')
  correct(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.correct(req, s, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('roster/:storeId')
  roster(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.rosterList(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('roster/:storeId')
  rosterCreate(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.rosterCreate(req, s, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @Patch('roster/:storeId/:id')
  rosterUpdate(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.rosterUpdate(req, s, id, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('roster/:storeId/:id/cancel')
  rosterCancel(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.rosterCancel(req, s, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('report/:storeId')
  report(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.report(req, s, q, this.t(e)); }
}
