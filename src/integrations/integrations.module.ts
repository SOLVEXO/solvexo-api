/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { StripeConnectModule } from '../stripe-connect/stripe-connect.module';
import { PaymentModule } from '../payment/payment.module';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { SafepayPaymentProvider } from './providers/safepay.provider';
import { StripePaymentProvider } from './providers/stripe-integration.provider';
import { JazzCashPaymentProvider } from './providers/jazzcash.provider';
import { PayFastPaymentProvider } from './providers/payfast.provider';
import { EasypaisaPaymentProvider } from './providers/easypaisa.provider';
import { WhatsAppCloudProvider } from './providers/whatsapp-cloud.provider';
import { PaymentProviderRegistry } from './payment-provider.registry';
import { IntegrationWebhookEventService } from './integration-webhook-event.service';
import { WhatsAppSenderService } from './whatsapp-sender.service';
import { StoreIntegrationsService } from './store-integrations.service';
import { CheckoutPaymentMethodsService } from './checkout-payment-methods.service';
import { StuckGatewayPaymentsService } from './stuck-gateway-payments.service';
import { PaymentWebhooksController } from './webhooks/payment-webhooks.controller';
import { WhatsAppWebhookController } from './webhooks/whatsapp-webhook.controller';
import { SellerIntegrationsController } from './seller-integrations.controller';
import { BuyerCheckoutPaymentsController } from './buyer-checkout-payments.controller';
import { TaxService } from '../tax/tax.service';
import { ShippingRatesService } from '../shipping-rates/shipping-rates.service';

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
    JazzCashPaymentProvider,
    PayFastPaymentProvider,
    EasypaisaPaymentProvider,
    StripePaymentProvider,
    WhatsAppCloudProvider,
    PaymentProviderRegistry,
    IntegrationWebhookEventService,
    WhatsAppSenderService,
    StoreIntegrationsService,
    CheckoutPaymentMethodsService,
    StuckGatewayPaymentsService,
    TaxService,
    ShippingRatesService,
  ],
  exports: [PaymentProviderRegistry, StuckGatewayPaymentsService, IntegrationWebhookEventService, WhatsAppCloudProvider, WhatsAppSenderService, TaxService, ShippingRatesService],
})
export class IntegrationsModule {}
