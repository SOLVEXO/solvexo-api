import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminAnalyticsModule } from '../admin-analytics/admin-analytics.module';
import { PlatformHealthModule } from '../platform-health/platform-health.module';
import { PlatformAlertsController } from './platform-alerts.controller';
import { PlatformAlertsService } from './platform-alerts.service';

@Module({
  imports: [AuthModule, AdminAnalyticsModule, PlatformHealthModule],
  controllers: [PlatformAlertsController],
  providers: [PlatformAlertsService],
  exports: [PlatformAlertsService],
})
export class PlatformAlertsModule {}
