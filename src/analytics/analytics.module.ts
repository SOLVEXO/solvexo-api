import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsReportsService } from './analytics-reports.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { ScheduledReportsService } from './scheduled-reports.service';
import { EmailService } from '../otp/services/email.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, AnalyticsReportsService, ScheduledReportsService, EmailService],
  exports: [AnalyticsService, AnalyticsReportsService, ScheduledReportsService],
})
export class AnalyticsModule {}
