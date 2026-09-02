/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';
import { PaymentModule } from '../payment/payment.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SafepayPaymentProvider } from './providers/safepay.provider';
import { StripePaymentProvider } from './providers/stripe-integration.provider';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { IntegrationWebhookEventService } from './integration-webhook-event.service';
import { WhatsAppSenderService } from './whatsapp-sender.service';
import { StoreIntegrationsService } from './store-integrations.service';
import { CheckoutPaymentMethodsService } from './checkout-payment-methods.service';
import { PaymentWebhooksController } from './webhooks/payment-webhooks.controller';
import { WhatsAppWebhookController } from './webhooks/whatsapp-webhook.controller';
import { SellerIntegrationsController } from './seller-integrations.controller';
import { BuyerCheckoutPaymentsController } from './buyer-checkout-payments.controller';

// AuthModule + RedisModule are required here because SellerIntegrationsController
// uses JwtAuthGuard — see NotificationsModule's doc comment for why both are
// needed even though nothing here calls AuthService directly.
@Module({
  imports: [StripeConnectModule, PaymentModule, AuthModule, RedisModule],
  controllers: [
    PaymentWebhooksController,
    WhatsAppWebhookController,
    SellerIntegrationsController,
    BuyerCheckoutPaymentsController,
  ],
  providers: [
    SafepayPaymentProvider,
    StripePaymentProvider,
    WhatsAppCloudProvider,
    PaymentProviderRegistry,
    IntegrationWebhookEventService,
    WhatsAppSenderService,
    StoreIntegrationsService,
    CheckoutPaymentMethodsService,
  ],
  exports: [PaymentProviderRegistry, IntegrationWebhookEventService, WhatsAppCloudProvider, WhatsAppSenderService],
})
export class IntegrationsModule {}
