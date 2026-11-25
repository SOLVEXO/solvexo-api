/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosService } from './pos.service';
import { PosAuthorizer } from './pos-authorizer.service';
import { PosFiscalService } from './pos-fiscal.service';

/**
 * G6.1 — fiscal documents that need attention (failed / rejected / retries stopped) and the owner's manual retry of a failed one.
 * The sale itself is never blocked by fiscalisation; these routes only surface and resolve what the sweep could not.
 */
@ApiTags('POS fiscal')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/fiscal')
export class PosFiscalController {
  constructor(private readonly fiscal: PosFiscalService, private readonly pos: PosService, private readonly auth: PosAuthorizer) {}

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get(':storeId/issues')
  async issues(@Req() req: any, @Param('storeId') storeId: string, @Headers('x-pos-employee-token') e?: string) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    await this.auth.authorize(req, { storeId, action: 'reports.view', employeeToken: e });
    return { success: true, data: { items: await this.fiscal.issues(storeId), contractVersion: 1 } };
  }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Post(':storeId/retry')
  async retry(@Req() req: any, @Param('storeId') storeId: string, @Body() b: { documentType?: 'invoice' | 'credit_note'; documentId?: string }, @Headers('x-pos-employee-token') e?: string) {
    await this.pos.verifyStoreOwnership(storeId, req.user.userId);
    const actor: any = await this.auth.authorize(req, { storeId, action: 'settings.store.edit', employeeToken: e }); // owner only
    const by = actor?.employeeId ?? req.user.userId;
    return { success: true, data: await this.fiscal.retry(storeId, b?.documentType as any, String(b?.documentId ?? ''), String(by)) };
  }
}
