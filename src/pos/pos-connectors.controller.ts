/* eslint-disable prettier/prettier */
import { Controller, Get, Headers, Param, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosConnectorsService } from './pos-connectors.service';

/** G5.4 / G5.7 — the status of every provider-dependent feature (switches + provider + test mode). Read-only. */
@ApiTags('POS connectors')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/connectors')
export class PosConnectorsController {
  constructor(private readonly svc: PosConnectorsService) {}
  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get(':storeId')
  status(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.status(req, s, { employee: e }); }
}
