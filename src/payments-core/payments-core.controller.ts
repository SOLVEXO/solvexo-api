/* eslint-disable prettier/prettier */
import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PosAuthGuard } from '../pos/guards/pos-auth.guard';
import { PosEntitlementGuard } from '../pos/guards/pos-entitlement.guard';
import { PosDeviceScopeInterceptor } from '../pos/pos-device-scope';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';
import { PosService } from '../pos/pos.service';
import { PaymentsCoreService } from './payments-core.service';

export class CreatePaymentIntentDto {
  @ApiProperty({ example: 150000, description: 'Amount to charge in the currency\'s MINOR unit (PKR 1,500.00 → 150000). Must equal the sale\'s server-computed share when the sale is completed.' })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor: number;
  @ApiProperty() @IsString() sessionId: string;
  @ApiProperty({ required: false, description: 'storeId — only needed for owner/staff JWTs; a device token is pinned to its store.' })
  @IsOptional() @IsString() storeId?: string;
  @ApiProperty({ required: false, description: 'The checkout attempt this belongs to (the sale\'s idempotency key). A late payment is attached back to it.' })
  @IsOptional() @IsString() @MaxLength(120) saleAttemptKey?: string;
  @ApiProperty({ required: false, description: 'Same key → same payment. Falls back to the Idempotency-Key header.' })
  @IsOptional() @IsString() @MaxLength(120) idempotencyKey?: string;
  @ApiProperty({ required: false, description: 'Mock provider only (never in production): scripted outcome.', enum: ['auto_confirm', 'auto_fail'] })
  @IsOptional() @IsIn(['auto_confirm', 'auto_fail']) mockScenario?: string;
}
export class RefundPaymentDto {
  @ApiProperty() @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amountMinor: number;
  @ApiProperty() @IsString() @MaxLength(300) reason: string;
  @ApiProperty({ description: 'Idempotency key of this refund; a retry with the same key never refunds twice.' }) @IsString() @MaxLength(120) refundKey: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() storeId?: string;
}
export class ReconcilePaymentDto {
  @ApiProperty({ enum: ['sale_recorded', 'refund', 'dismissed'] }) @IsIn(['sale_recorded', 'refund', 'dismissed']) resolution: 'sale_recorded' | 'refund' | 'dismissed';
  @ApiProperty({ required: false }) @IsOptional() @IsString() saleId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(300) note?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() storeId?: string;
}

/** POS routes for digital (QR) payments. Same guard stack as the sale routes: device token or owner JWT, POS feature flag, POS plan for creating. */
@ApiTags('POS payments')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard)
@UseInterceptors(PosDeviceScopeInterceptor)
@RequireFeature('posMode')
@Controller('api/pos/payments')
export class PaymentsCoreController {
  constructor(private readonly payments: PaymentsCoreService, private readonly pos: PosService) {}

  /** The store this call is for: a device token pins it; an owner/staff JWT must name it and own it. */
  private async storeOf(req: any, asked?: string): Promise<string> {
    const pinned: string | undefined = req.user?.storeId;
    if (pinned) return pinned;
    if (!asked) throw new BadRequestException({ code: 'STORE_REQUIRED', message: 'storeId is required' });
    await this.pos.verifyStoreOwnership(asked, req.user.userId);
    return asked;
  }

  private async actor(req: any, storeId: string, token: string | undefined, manager: boolean) {
    if (manager) { const m = await this.pos.requireManagerEmployee(token, storeId, 'manage payments'); return { employeeId: m.employeeId }; }
    const a = await this.pos.verifyEmployeeToken(token, storeId);
    if (!a) throw new ForbiddenException({ code: 'EMPLOYEE_SESSION_REQUIRED', message: 'A valid employee PIN session is required' });
    return { employeeId: a.employeeId };
  }

  @UseGuards(PosAuthGuard, RolesGuard, PosEntitlementGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @Post('intents')
  async create(@Req() req: any, @Body() dto: CreatePaymentIntentDto, @Headers('x-pos-employee-token') token?: string, @Headers('idempotency-key') headerKey?: string) {
    const storeId = await this.storeOf(req, dto.storeId);
    const a = await this.actor(req, storeId, token, false);
    const idempotencyKey = dto.idempotencyKey || headerKey;
    if (!idempotencyKey) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Send idempotencyKey or an Idempotency-Key header' });
    const data = await this.payments.createIntent(
      { storeId, deviceId: req.user?.posDevice?.deviceId ?? null, employeeId: a.employeeId },
      { amountMinor: dto.amountMinor, sessionId: dto.sessionId, saleAttemptKey: dto.saleAttemptKey ?? null, idempotencyKey, mockScenario: process.env.NODE_ENV === 'production' ? null : dto.mockScenario ?? null },
    );
    return { success: true, data };
  }

  /** Static segment before `:id` routes. */
  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('attention')
  async attention(@Req() req: any, @Query('storeId') storeId?: string) {
    return { success: true, data: await this.payments.listAttention(await this.storeOf(req, storeId)) };
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @Get('intents/:id')
  async get(@Req() req: any, @Param('id') id: string, @Query('storeId') storeId?: string) {
    return { success: true, data: await this.payments.getIntent(await this.storeOf(req, storeId), id) };
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @HttpCode(200)
  @Post('intents/:id/presented')
  async presented(@Req() req: any, @Param('id') id: string, @Query('storeId') storeId?: string) {
    return { success: true, data: await this.payments.markPresented(await this.storeOf(req, storeId), id) };
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @HttpCode(200)
  @Post('intents/:id/cancel')
  async cancel(@Req() req: any, @Param('id') id: string, @Query('storeId') storeId?: string, @Headers('x-pos-employee-token') token?: string) {
    const sid = await this.storeOf(req, storeId);
    const a = await this.actor(req, sid, token, false);
    return { success: true, data: await this.payments.cancel(sid, id, a.employeeId) };
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(200)
  @Post('intents/:id/refunds')
  async refund(@Req() req: any, @Param('id') id: string, @Body() dto: RefundPaymentDto, @Headers('x-pos-employee-token') token?: string) {
    const sid = await this.storeOf(req, dto.storeId);
    const a = await this.actor(req, sid, token, true);
    return { success: true, data: await this.payments.refund(sid, id, a, dto) };
  }

  @UseGuards(PosAuthGuard, RolesGuard)
  @Roles('seller')
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(200)
  @Post('intents/:id/reconcile')
  async reconcile(@Req() req: any, @Param('id') id: string, @Body() dto: ReconcilePaymentDto, @Headers('x-pos-employee-token') token?: string) {
    const sid = await this.storeOf(req, dto.storeId);
    const a = await this.actor(req, sid, token, true);
    return { success: true, data: await this.payments.reconcile(sid, id, a, dto) };
  }
}
