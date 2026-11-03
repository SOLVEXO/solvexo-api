/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { resolveCountryFromIp } from '../common/geo-locate.util';
import { SiteAnalyticsService } from './site-analytics.service';
import { SiteAnalyticsSettingsDto, SiteRangeDto } from './site-analytics.dto';

/** Super Admin → Analytics → Website visitors. */
@ApiTags('Admin Site Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/site-analytics')
export class SiteAnalyticsAdminController {
  constructor(private readonly svc: SiteAnalyticsService) {}

  @RequirePermission('analytics.view')
  @Get('settings')
  settings() {
    return this.svc.getSettings();
  }

  @RequirePermission('config.manage')
  @Put('settings')
  saveSettings(@Req() req: any, @Body() dto: SiteAnalyticsSettingsDto) {
    return this.svc.saveSettings(dto, req.user?.userId ?? null);
  }

  @RequirePermission('analytics.view')
  @Get('overview')
  overview(@Query() q: SiteRangeDto) {
    return this.svc.overview(q.range ?? '28d');
  }

  @RequirePermission('analytics.view')
  @Get('acquisition')
  acquisition(@Query() q: SiteRangeDto) {
    return this.svc.acquisition(q.range ?? '28d');
  }

  @RequirePermission('analytics.view')
  @Get('content')
  content(@Query() q: SiteRangeDto) {
    return this.svc.content(q.range ?? '28d');
  }

  @RequirePermission('analytics.view')
  @Get('realtime')
  realtime() {
    return this.svc.realtime();
  }

  @RequirePermission('analytics.view')
  @Get('funnel')
  funnel(@Query() q: SiteRangeDto) {
    return this.svc.funnel(q.range ?? '28d');
  }
}

/** Public: the public site asks which GA id to load and whether this visitor must consent first. */
@ApiTags('Site Analytics')
@Controller('api/site-analytics')
export class SiteAnalyticsPublicController {
  constructor(private readonly svc: SiteAnalyticsService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('config')
  config(@Req() req: any) {
    const header = (name: string) => {
      const v = req.headers?.[name];
      return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
    };
    const country = header('cf-ipcountry') ?? header('x-vercel-ip-country') ?? resolveCountryFromIp(req.ip);
    return this.svc.getPublicConfig(country);
  }
}
