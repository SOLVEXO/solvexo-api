/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { PlatformSubscriptionsController } from './platform-subscriptions.controller';
import { PlatformSubscriptionsService } from './platform-subscriptions.service';
import { PlatformBillingNotificationsService } from './platform-billing-notifications.service';
import { EmailService } from '../otp/services/email.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

// Global so ProductsService can inject PlatformSubscriptionsService for the
// product-limit check without importing this module directly (same pattern
// as SubscriptionsModule/LoyaltyModule).
@Global()
@Module({
  imports: [AuthModule, RedisModule, SubscriptionsModule],
  controllers: [PlatformSubscriptionsController],
  providers: [PlatformSubscriptionsService, PlatformBillingNotificationsService, EmailService],
  exports: [PlatformSubscriptionsService],
})
export class PlatformSubscriptionsModule {}
