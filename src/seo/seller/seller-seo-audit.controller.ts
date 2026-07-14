/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Param, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { EntitlementsService } from 'src/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoAuditService } from '../services/seo-audit.service';

@ApiTags('Seller SEO — Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store/:storeId/seo/audit')
export class SellerSeoAuditController {
  constructor(
    private readonly audit: SeoAuditService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @Post('run')
  async run(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    await this.entitlements.assertFeatureAllowed(storeId, 'advancedSeoToolsAllowed', 'SEO Audit');
    return this.audit.enqueueRun(storeId);
  }

  @Get('latest')
  async getLatest(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.audit.getLatest(storeId);
  }

  @Get('history')
  async getHistory(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.audit.getHistory(storeId, query);
  }
}
