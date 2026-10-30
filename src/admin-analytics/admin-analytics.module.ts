import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
// Phase 10 — Platform Health. A separate module (own real dependencies:
// Terminus, BullMQ queues) rather than folded into AdminAnalyticsService —
// see platform-health.service.ts's header comment for why every number it
// returns is real, live infrastructure data, never derived from business analytics.
import { AdminFinanceModule } from '../admin-finance/admin-finance.module';
import { PlatformHealthModule } from '../platform-health/platform-health.module';
import { AdminAnalyticsController } from './admin-analytics.controller';
import { AdminAnalyticsService } from './admin-analytics.service';
import { SaasMetricsService } from './saas-metrics.service';
import { ActivationFunnelService } from './activation-funnel.service';
import { PlanInsightsService } from './plan-insights.service';
import { PlatformMrrSnapshot, PlatformMrrSnapshotSchema } from './schemas/platform-mrr-snapshot.schema';

@Module({
  imports: [
    AuthModule, RedisModule, PlatformHealthModule, AdminFinanceModule,
    MongooseModule.forFeature([{ name: PlatformMrrSnapshot.name, schema: PlatformMrrSnapshotSchema }]),
  ],
  controllers: [AdminAnalyticsController],
  providers: [AdminAnalyticsService, SaasMetricsService, ActivationFunnelService, PlanInsightsService],
  exports: [AdminAnalyticsService, SaasMetricsService, ActivationFunnelService],
})
export class AdminAnalyticsModule {}
