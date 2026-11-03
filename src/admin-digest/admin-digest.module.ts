/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminAnalyticsModule } from '../admin-analytics/admin-analytics.module';
import { AdminClientsModule } from '../admin-clients/admin-clients.module';
import { PlatformAlertsModule } from '../platform-alerts/platform-alerts.module';
import { AdminDigestController } from './admin-digest.controller';
import { AdminDigestService } from './admin-digest.service';

// NotificationsModule is global. RedisModule is needed by JwtAuthGuard (see common/module-redis-import.spec.ts).
@Module({
  imports: [AuthModule, RedisModule, AdminAnalyticsModule, AdminClientsModule, PlatformAlertsModule],
  controllers: [AdminDigestController],
  providers: [AdminDigestService],
})
export class AdminDigestModule {}
