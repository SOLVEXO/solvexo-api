/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DatabaseService } from '../database/databaseservice';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { PlatformTaxService } from './platform-tax.service';

/** What Solvexo's tax will add to a plan fee / add-on for THIS seller's store, so the seller sees it before paying. */
@ApiTags('Platform Tax')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/platform-tax')
export class PlatformTaxQuoteController {
  constructor(private readonly service: PlatformTaxService, private readonly db: DatabaseService) {}

  @Get('quote/:storeId')
  async quote(@Param('storeId') storeId: string, @Query('amountUSD') amountUSD: string, @Request() req: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    const net = Math.min(1_000_000, Math.max(0, Number(amountUSD) || 0));
    return { success: true, data: await this.service.quoteForStore(storeId, net) };
  }
}
