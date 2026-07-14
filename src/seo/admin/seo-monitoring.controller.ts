/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { SeoMonitoringService } from '../services/seo-monitoring.service';

class RefreshCwvDto {
  @IsArray() @IsString({ each: true })
  urls: string[];
}

@ApiTags('Admin SEO — Monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/seo/monitoring')
export class AdminSeoMonitoringController {
  constructor(private readonly monitoring: SeoMonitoringService) {}

  @Get('crawl-logs')
  getCrawlLogs(@Query() query: any) {
    return this.monitoring.getCrawlLogs(null, query);
  }

  @Get('crawl-stats')
  getCrawlStats() {
    return this.monitoring.getCrawlStats(null);
  }

  @Get('index-snapshots')
  getIndexSnapshots() {
    return this.monitoring.getIndexSnapshots('platform', null);
  }

  @Post('index-snapshots/refresh')
  refreshIndexSnapshots() {
    return this.monitoring.refreshIndexSnapshots('platform', null);
  }

  @Get('cwv')
  getCoreWebVitals() {
    return this.monitoring.getCoreWebVitals(null);
  }

  @Post('cwv/refresh')
  refreshCoreWebVitals(@Body() dto: RefreshCwvDto) {
    return this.monitoring.refreshCoreWebVitals(dto.urls, null);
  }
}
