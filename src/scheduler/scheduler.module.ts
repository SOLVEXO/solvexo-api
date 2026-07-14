/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PlatformSubscriptionsModule } from '../platform-subscriptions/platform-subscriptions.module';
import { FinanceModule } from '../finance/finance.module';
import { RedisModule } from '../redis/redis.module';
import { SeoModule } from '../seo/seo.module';

@Module({
  imports: [ScheduleModule.forRoot(), SubscriptionsModule, PlatformSubscriptionsModule, FinanceModule, RedisModule, SeoModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
