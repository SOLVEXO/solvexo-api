/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Query, Body, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { SeoMonitoringService } from '../services/seo-monitoring.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator';
class RefreshCwvDto {
  @IsArray() @IsString({ each: true })
  urls: string[];
}

@ApiTags('Admin SEO — Monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/monitoring')
export class AdminSeoMonitoringController {
  constructor(private readonly monitoring: SeoMonitoringService) {}

  @RequirePermission('seo.manage')
  @Get('crawl-logs')
  getCrawlLogs(@Query() query: any) {
    return this.monitoring.getCrawlLogs(null, query);
  }

  @RequirePermission('seo.manage')
  @Get('crawl-stats')
  getCrawlStats() {
    return this.monitoring.getCrawlStats(null);
  }

  @RequirePermission('seo.manage')
  @Get('index-snapshots')
  getIndexSnapshots() {
    return this.monitoring.getIndexSnapshots('platform', null);
  }

  @RequirePermission('seo.manage')
  @Post('index-snapshots/refresh')
  refreshIndexSnapshots() {
    return this.monitoring.refreshIndexSnapshots('platform', null);
  }

  @RequirePermission('seo.manage')
  @Get('cwv')
  getCoreWebVitals() {
    return this.monitoring.getCoreWebVitals(null);
  }

  @RequirePermission('seo.manage')
  @Post('cwv/refresh')
  refreshCoreWebVitals(@Body() dto: RefreshCwvDto) {
    return this.monitoring.refreshCoreWebVitals(dto.urls, null);
  }
}
