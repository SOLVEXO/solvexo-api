/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { SeoAdminAnalyticsService } from '../services/seo-admin-analytics.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// Store-scoped SEO analytics — reuses the exact same scoped read logic as
// the admin dashboard (SeoAdminAnalyticsService already accepts a scope
// param), mirroring how `analytics`/`admin-analytics` share their core.
@ApiTags('Seller SEO — Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/analytics')
export class SellerSeoAnalyticsController {
  constructor(
    private readonly analytics: SeoAdminAnalyticsService,
    private readonly db: DatabaseService,
  ) {}

  @Get('search-performance')
  async getSearchPerformance(@Req() req: any, @Param('storeId') storeId: string, @Query('days') days?: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.analytics.getSearchPerformance('store', storeId, Number(days) || 28);
  }

  @Get('organic-traffic')
  async getOrganicTraffic(@Req() req: any, @Param('storeId') storeId: string, @Query('days') days?: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, req.user.userId);
    return this.analytics.getOrganicTraffic('store', storeId, Number(days) || 28);
  }
}
