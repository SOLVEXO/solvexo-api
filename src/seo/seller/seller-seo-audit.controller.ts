/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Param, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { SeoAuditService } from '../services/seo-audit.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
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
