/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UseGuards, UsePipes, ValidationPipe, Optional } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { AdminConfigService } from '../admin-config/admin-config.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { TransactionFeeBillingService } from './transaction-fee-billing.service';

export class ReportFeePaidDto {
  /** For example the transfer reference. */
  @IsOptional() @IsString() @MaxLength(300) note?: string;
}

/** A seller's view of the third-party transaction fees accruing on their store and the monthly bills that collected them. */
@ApiTags('Transaction fees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('api/transaction-fees')
export class TransactionFeesController {
  constructor(
    private readonly billing: TransactionFeeBillingService,
    private readonly db: DatabaseService,
    @Optional() private readonly adminConfig?: AdminConfigService,
  ) {}

  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view')
  @Get(':storeId')
  async overview(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    const overview = await this.billing.getOverview(storeId);
    return { success: true, data: { ...overview, payTo: await this.payTo() } };
  }

  /** The seller says they sent the bank transfer for a bill that is waiting for a payment. The admin is told to check and close it. */
  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Post(':storeId/bills/:billId/paid-notice')
  async reportPaid(@Req() req: any, @Param('storeId') storeId: string, @Param('billId') billId: string, @Body() dto: ReportFeePaidDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return { success: true, data: await this.billing.reportPaid(storeId, billId, dto?.note ?? null) };
  }

  /** Where to send the money: the company's bank / wallet details the admin set, or null when none are set. */
  private async payTo() {
    const c: any = await this.adminConfig?.getManualPaymentConfig().catch(() => null);
    if (!c) return null;
    const out = {
      bankName: c.bankName ?? null, accountTitle: c.accountTitle ?? null, accountNumber: c.accountNumber ?? null, iban: c.iban ?? null,
      jazzcashNumber: c.jazzcashNumber ?? null, easypaisaNumber: c.easypaisaNumber ?? null, instructions: c.instructions ?? null,
    };
    return Object.values(out).some((v) => !!v) ? out : null;
  }
}
