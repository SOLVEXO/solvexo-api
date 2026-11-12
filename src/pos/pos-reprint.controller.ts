/* eslint-disable prettier/prettier */
import { Body, Controller, Headers, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PosReprintService } from './pos-reprint.service';

@ApiTags('POS reprints')
@ApiBearerAuth()
@Controller('api/pos/reprints')
export class PosReprintController {
  constructor(private readonly reprints: PosReprintService) {}

  /** G4.8: record a reprint (body { documentType: sale | invoice | credit_note, documentId, reason? }); a manager's token when the store requires a PIN. */
  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Post(':storeId')
  reprint(@Req() req: any, @Param('storeId') storeId: string, @Body() body: any, @Headers('x-pos-employee-token') e?: string, @Headers('x-pos-approver-token') ap?: string) {
    return this.reprints.reprint(req, storeId, body, { employee: e, approver: ap });
  }
}
