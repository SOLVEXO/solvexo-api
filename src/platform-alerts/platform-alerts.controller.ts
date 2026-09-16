/* eslint-disable prettier/prettier */
import { Controller, Get, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminAnalyticsQueryDto } from '../admin-analytics/dto/admin-analytics-query.dto';
import { PlatformAlertsService } from './platform-alerts.service';

// Same URL family as Phase 9/10's platform/* endpoints
// (platform/seller-acquisition, platform/health) — a separate controller
// (not a method on AdminAnalyticsController) purely to avoid a circular
// module dependency: this service composes AdminAnalyticsService AND
// PlatformHealthService, and AdminAnalyticsModule already imports
// PlatformHealthModule, so AdminAnalyticsModule importing this module back
// would be circular. The route path is identical either way.
@ApiTags('Admin Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/analytics/platform')
export class PlatformAlertsController {
  constructor(private readonly platformAlertsService: PlatformAlertsService) {}

  @Get('alerts')
  getAlerts(@Query() query: AdminAnalyticsQueryDto) {
    return this.platformAlertsService.getAlerts(query);
  }
}
