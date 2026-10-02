/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
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

/** A seller's view of the third-party transaction fees accruing on their store and the monthly bills that collected them. */
@ApiTags('Transaction fees')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Controller('api/transaction-fees')
export class TransactionFeesController {
  constructor(
    private readonly billing: TransactionFeeBillingService,
    private readonly db: DatabaseService,
  ) {}

  @Roles('seller', 'staff')
  @RequirePermission('settings.billing.view')
  @Get(':storeId')
  async overview(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return { success: true, data: await this.billing.getOverview(storeId) };
  }
}
