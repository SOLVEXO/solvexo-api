/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosEntitlementGuard } from './guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosCashService } from './pos-cash.service';

/** G3.5 — cash in / out, expenses (+ private receipt photo) and the daybook. WHO may do WHAT is the permission matrix. Reads stay on a lapsed plan; writes need it. */
@ApiTags('POS cash')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/cash')
export class PosCashController {
  constructor(private readonly svc: PosCashService) {}
  private t = (e?: string, a?: string) => ({ employee: e, approver: a });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('config/:storeId')
  config(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.config(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('movements/:storeId')
  move(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string, @Headers('x-pos-approver-token') a?: string) { return this.svc.move(req, s, body, this.t(e, a)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('expenses/:storeId')
  expense(@Req() req: any, @Param('storeId') s: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string, @Headers('x-pos-approver-token') a?: string) { return this.svc.expense(req, s, body, this.t(e, a)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('expenses/:storeId')
  expenses(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.expenses(req, s, q, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('expenses/:storeId/:id')
  expenseGet(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.expenseGet(req, s, id, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post('expenses/:storeId/:id/decision')
  decide(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.expenseDecide(req, s, id, body, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard) @Roles('seller')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: Number(process.env.EXPENSE_RECEIPT_MAX_BYTES) >= 1024 ? Number(process.env.EXPENSE_RECEIPT_MAX_BYTES) : 5 * 1024 * 1024 } }))
  @Post('expenses/:storeId/:id/receipt')
  receipt(@Req() req: any, @Param('storeId') s: string, @Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Headers('x-pos-employee-token') e?: string) { return this.svc.receiptUpload(req, s, id, file, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('expenses/:storeId/:id/receipt')
  async receiptLink(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('storeId') s: string, @Param('id') id: string, @Headers('x-pos-employee-token') e?: string) {
    res.setHeader('Cache-Control', 'no-store');
    return this.svc.receiptLink(req, s, id, this.t(e));
  }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get('daybook/:storeId')
  daybook(@Req() req: any, @Param('storeId') s: string, @Query() q: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.daybook(req, s, q, this.t(e)); }
}
