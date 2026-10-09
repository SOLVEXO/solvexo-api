import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsReportsService } from './analytics-reports.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsReportsService],
  exports: [AnalyticsService, AnalyticsReportsService],
})
export class AnalyticsModule {}
