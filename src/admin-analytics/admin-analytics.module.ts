import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
// Phase 10 — Platform Health. A separate module (own real dependencies:
// Terminus, BullMQ queues) rather than folded into AdminAnalyticsService —
// see platform-health.service.ts's header comment for why every number it
// returns is real, live infrastructure data, never derived from business analytics.
import { PlatformHealthModule } from '../platform-health/platform-health.module';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';

@Module({
  imports: [AuthModule, RedisModule, PlatformHealthModule],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService],
  exports: [AdminAnalyticsService],
})
export class AdminAnalyticsModule {}
