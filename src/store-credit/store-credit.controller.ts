/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Query, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { resolveBuyerStoreScope } from '../common/store-scope.util';
import { DatabaseService } from '../database/databaseservice';
import { StoreCreditService } from './store-credit.service';
import { AdjustStoreCreditDto } from './dto/adjust-store-credit.dto';

@ApiTags('Store credit')
@ApiBearerAuth()
@Controller('api/store-credit')
export class StoreCreditController {
  constructor(
    private readonly storeCredit: StoreCreditService,
    private readonly db: DatabaseService,
  ) {}

  // ── Buyer: my balance in this store (declared first so "my" is never read as a :storeId) ──
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('user')
  @Get('my')
  async myBalance(@Req() req: any, @Query('storeId') queryStoreId: string, @Query() query: any) {
    const storeId = resolveBuyerStoreScope(req.user.storeId, queryStoreId);
    return this.storeCredit.getMyOverview(storeId, req.user.userId, query);
  }

  // ── Merchant: a customer's balance + ledger ──
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.view')
  @Get(':storeId/customers/:customerId')
  async customerBalance(@Req() req: any, @Param('storeId') storeId: string, @Param('customerId') customerId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.storeCredit.getCustomerOverview(storeId, customerId, query);
  }

  // ── Merchant: issue / add / remove credit ──
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('customers.edit')
  @Post(':storeId/customers/:customerId/adjust')
  async adjust(@Req() req: any, @Param('storeId') storeId: string, @Param('customerId') customerId: string, @Body() dto: AdjustStoreCreditDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    await this.storeCredit.getCustomerOverview(storeId, customerId, { limit: 1 }); // asserts the customer belongs to this store
    return this.storeCredit.adjust(storeId, customerId, dto, {
      actorId: req.user.userId ?? req.user.sellerId ?? null,
      actorRole: req.user.role === 'staff' ? 'staff' : 'seller',
    });
  }
}
