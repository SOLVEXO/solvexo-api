/* eslint-disable prettier/prettier */
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { SeoAdminAnalyticsService } from '../services/seo-admin-analytics.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator';
@ApiTags('Admin SEO — Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/analytics')
export class AdminSeoAnalyticsController {
  constructor(private readonly analytics: SeoAdminAnalyticsService) {}

  @RequirePermission('seo.manage')
  @Get('overview')
  getOverview(@Query('days') days?: string) {
    return this.analytics.getOverview('platform', null, Number(days) || 28);
  }

  @RequirePermission('seo.manage')
  @Get('search-performance')
  getSearchPerformance(@Query('days') days?: string) {
    return this.analytics.getSearchPerformance('platform', null, Number(days) || 28);
  }

  @RequirePermission('seo.manage')
  @Get('organic-traffic')
  getOrganicTraffic(@Query('days') days?: string) {
    return this.analytics.getOrganicTraffic('platform', null, Number(days) || 28);
  }
}
