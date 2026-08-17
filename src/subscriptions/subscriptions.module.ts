/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionBenefitsService } from './subscription-benefits.service';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { CurrencyDisplayService } from './currency-display.service';
import { SubscriptionNotificationsService } from './subscription-notifications.service';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { StripeWebhookService } from './webhooks/stripe-webhook.service';
import { StripeWebhookProcessor } from './webhooks/stripe-webhook.processor';
import { SubscriptionEmailProcessor } from './subscription-email.processor';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { EmailService } from '../otp/services/email.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { FinanceModule } from '../finance/finance.module';
import { QueueModule } from '../queues/queue.module';

// Global so ProductsService/StoreService/CheckoutService/OrdersService can
// inject SubscriptionBenefitsService without importing this module directly
// (same pattern as ActivityLogModule/LoyaltyModule).
@Global()
@Module({
  imports: [AuthModule, RedisModule, FinanceModule, QueueModule],
  controllers: [SubscriptionsController, StripeWebhookController],
  providers: [
    SubscriptionsService,
    SubscriptionBenefitsService,
    PaymentGatewayService,
    CurrencyDisplayService,
    SubscriptionNotificationsService,
    StripeWebhookService,
    StripeWebhookProcessor,
    SubscriptionEmailProcessor,
    IdempotencyInterceptor,
    EmailService,
  ],
  exports: [SubscriptionsService, SubscriptionBenefitsService, PaymentGatewayService],
})
export class SubscriptionsModule {}
