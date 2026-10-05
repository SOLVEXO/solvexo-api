/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { StripeWebhookAdminController } from './webhooks/stripe-webhook-admin.controller';
import { StripeWebhookService } from './webhooks/stripe-webhook.service';
import { StripeWebhookProcessor } from './webhooks/stripe-webhook.processor';
import { BuyerSubscriptionWindDownService } from './buyer-subscription-wind-down.service';
import { BuyerSubscriptionWindDownController } from './buyer-subscription-wind-down.controller';
import { CriticalAlertService } from '../common/critical-alert.service';
import { EmailService } from '../otp/services/email.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { QueueModule } from '../queues/queue.module';

/**
 * Despite the name this module no longer contains any buyer-facing "VIP / membership plans"
 * (that feature was removed — Shopify has no such core feature). It keeps the shared Stripe
 * payment gateway wrapper, the Stripe webhook intake + queue processor (seller platform plans,
 * POS plans, promotions … all fan out from here), and the one-off wind-down of the buyers who
 * were already subscribed when the feature was retired.
 */
@Global()
@Module({
  imports: [AuthModule, RedisModule, QueueModule],
  controllers: [StripeWebhookController, StripeWebhookAdminController, BuyerSubscriptionWindDownController],
  providers: [
    PaymentGatewayService,
    StripeWebhookService,
    StripeWebhookProcessor,
    BuyerSubscriptionWindDownService,
    CriticalAlertService,
    // CriticalAlertService sends its ops emails through EmailService — it must be a provider of THIS module
    // (the module used to get it indirectly from the old buyer-subscription code that was removed).
    EmailService,
  ],
  exports: [PaymentGatewayService, BuyerSubscriptionWindDownService],
})
export class SubscriptionsModule {}
