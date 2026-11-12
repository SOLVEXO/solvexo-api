/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PosAuthGuard } from './guards/pos-auth.guard';
import { PosDeviceScopeInterceptor } from './pos-device-scope';
import { PosReceiptDeliveryService } from './pos-receipt-delivery.service';

/** G5.3 — send a receipt's public link by e-mail / SMS (each channel off per store until turned on). */
@ApiTags('POS receipts')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/receipt-delivery')
export class PosReceiptDeliveryController {
  constructor(private readonly svc: PosReceiptDeliveryService) {}
  private t = (e?: string) => ({ employee: e });

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @Get(':storeId')
  channels(@Req() req: any, @Param('storeId') s: string, @Headers('x-pos-employee-token') e?: string) { return this.svc.channels(req, s, this.t(e)); }

  @UseGuards(PosAuthGuard, RolesGuard) @Roles('seller') @UseInterceptors(IdempotencyInterceptor) @Throttle({ default: { limit: 20, ttl: 60_000 } }) @Post(':storeId/:saleId')
  send(@Req() req: any, @Param('storeId') s: string, @Param('saleId') id: string, @Body() b: any, @Headers('x-pos-employee-token') e?: string) { return this.svc.send(req, s, id, b, this.t(e)); }
}
