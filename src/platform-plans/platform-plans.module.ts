/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { PlatformPlansController } from './platform-plans.controller';
import { SellerPlatformSubscriptionsController } from './seller-platform-subscriptions.controller';
import { PlatformPlansService } from './platform-plans.service';
import { PlatformPlanCatalogService } from './platform-plan-catalog.service';
import { SellerPlatformSubscriptionsService } from './seller-platform-subscriptions.service';
import { BillingTimelineService } from './billing-timeline.service';
import { EntitlementsService } from './entitlements.service';
import { AiCreditsService } from './ai-credits.service';
import { PlatformPlanNotificationsService } from './platform-plan-notifications.service';
import { TransactionFeeBillingService } from './transaction-fee-billing.service';
import { LegacyPlatformSubscriptionBackfillService } from './legacy-platform-subscription-backfill.service';
import { TransactionFeesController } from './transaction-fees.controller';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';
import { BillingAccessGuard } from './guards/billing-access.guard';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PlatformTaxModule } from '../platform-tax/platform-tax.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { EmailService } from '../otp/services/email.service';
import { CriticalAlertService } from '../common/critical-alert.service';

// @Global() so any module (Products, Employee/POS, Store, Loyalty, Finance,
// the buyer-facing Subscriptions module) can inject EntitlementsService /
// AiCreditsService to gate a feature behind a platform-plan tier, without
// each of those modules needing to import this one explicitly — identical
// reasoning to why SubscriptionsModule/ActivityLogModule are global.
@Global()
@Module({
  imports: [AuthModule, RedisModule, SubscriptionsModule, ExchangeRateModule, PlatformTaxModule, AdminConfigModule],
  // Controller order matters here — Express/Nest routing is first-match, in
  // controller-then-method declaration order (same "static-before-dynamic"
  // convention used throughout this codebase's other controllers):
  //   1. PlatformPlansController's static "public"/"admin/*" routes must come
  //      before SellerPlatformSubscriptionsController's catch-all ":storeId".
  controllers: [PlatformPlansController, SellerPlatformSubscriptionsController, TransactionFeesController],
  providers: [
    PlatformPlansService,
    PlatformPlanCatalogService,
    SellerPlatformSubscriptionsService,
    BillingTimelineService,
    LegacyPlatformSubscriptionBackfillService,
    EntitlementsService,
    AiCreditsService,
    PlatformPlanNotificationsService,
    TransactionFeeBillingService,
    EmailService,
    CriticalAlertService,
    BillingAccessGuard,
  ],
  exports: [PlatformPlansService, PlatformPlanCatalogService, SellerPlatformSubscriptionsService, EntitlementsService, AiCreditsService, BillingAccessGuard, TransactionFeeBillingService],
})
export class PlatformPlansModule {}
