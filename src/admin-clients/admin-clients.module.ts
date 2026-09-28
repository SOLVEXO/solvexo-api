/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AdminUsersModule } from '../admin-users/admin-users.module';
import { AdminAnalyticsModule } from '../admin-analytics/admin-analytics.module';
import { AdminFinanceModule } from '../admin-finance/admin-finance.module';
import { AdminModerationModule } from '../admin-moderation/admin-moderation.module';
// PlatformPlansModule is @Global() (see its own module file) — no explicit
// import needed for SellerPlatformSubscriptionsService to be injectable here.
import { AdminClientsController } from './admin-clients.controller';
import { AdminClientsService } from './admin-clients.service';

@Module({
  imports: [AuthModule, AdminUsersModule, AdminAnalyticsModule, AdminFinanceModule, AdminModerationModule],
  controllers: [AdminClientsController],
  providers: [AdminClientsService],
  exports: [AdminClientsService],
})
export class AdminClientsModule {}
