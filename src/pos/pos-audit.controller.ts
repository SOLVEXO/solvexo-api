/* eslint-disable prettier/prettier */
import { Controller, Get, Headers, Param, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosAuditSealService } from './pos-audit-seal.service';
import { DatabaseService } from '@/database/databaseservice';

/** G4.3 — the nightly audit seals: managers / owner can check that nothing sealed has changed. */
@ApiTags('POS audit')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/audit')
export class PosAuditController {
  constructor(private readonly seals: PosAuditSealService, private readonly pos: PosService, private readonly auth: PosAuthorizer, private readonly db: DatabaseService) {}

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('verify/:storeId')
  async verify(@Req() req: any, @Param('storeId') s: string, @Query('from') from?: string, @Query('to') to?: string, @Headers('x-pos-employee-token') e?: string) {
    await this.pos.verifyStoreOwnership(s, req.user.userId);
    const a = await this.auth.authorize(req, { storeId: s, action: 'audit.verify', employeeToken: e });
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const r = await this.seals.verify(s, from && day.test(from) ? from : undefined, to && day.test(to) ? to : undefined);
    await (this.db.repositories as any).posAuditLogModel.create([{ storeId: s, employeeId: a.employeeId, action: 'audit_verified', targetId: s, targetType: 'audit', metadata: { from: from ?? null, to: to ?? null, ok: r.ok, days: r.days } }]);
    return { success: true, data: r };
  }
}
