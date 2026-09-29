/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { AdminAnalyticsModule } from '../admin-analytics/admin-analytics.module';
import { AdminFinanceModule } from '../admin-finance/admin-finance.module';
import { AdminModerationModule } from '../admin-moderation/admin-moderation.module';
// PlatformPlansModule is @Global() (see its own module file) — no explicit
// import needed for SellerPlatformSubscriptionsService to be injectable here.
import { AdminClientsController } from './admin-clients.controller';
import { AdminClientsService } from './admin-clients.service';

@Module({
  // RedisModule — JwtAuthGuard (used on this controller) depends on
  // RedisService for its session-revocation check; every other admin module
  // using this same guard imports RedisModule too (RedisModule isn't
  // @Global(), so it must be imported wherever the guard is applied) —
  // this was missed initially and caused a 500 in production
  // ("Cannot read properties of undefined (reading 'isConnected')").
  imports: [AuthModule, RedisModule, AdminUsersModule, AdminAnalyticsModule, AdminFinanceModule, AdminModerationModule],
  controllers: [AdminClientsController],
  providers: [AdminClientsService],
  exports: [AdminClientsService],
})
export class AdminClientsModule {}
