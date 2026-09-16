/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Param, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { SeoAuditService } from '../services/seo-audit.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/audit')
export class SellerSeoAuditController {
  constructor(
    private readonly audit: SeoAuditService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  @RequirePermission('seo.manage')
  @Post('run')
  async run(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    await this.entitlements.assertFeatureAllowed(storeId, 'advancedSeoToolsAllowed', 'SEO Audit');
    return this.audit.enqueueRun(storeId);
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('latest')
  async getLatest(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.audit.getLatest(storeId);
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('history')
  async getHistory(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.audit.getHistory(storeId, query);
  }
}
