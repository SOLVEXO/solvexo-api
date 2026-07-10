/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerService } from './scheduler.service';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { FinanceModule } from '../finance/finance.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [ScheduleModule.forRoot(), SubscriptionsModule, FinanceModule, RedisModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
