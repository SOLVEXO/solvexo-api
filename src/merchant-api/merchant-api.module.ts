import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { ApiToken, ApiTokenSchema, WebhookDelivery, WebhookDeliverySchema, WebhookSubscription, WebhookSubscriptionSchema } from './merchant-api.schema';
import { ApiTokenGuard, ApiTokensService } from './api-tokens.service';
import { MerchantApiSettingsController, MerchantApiV1Controller } from './merchant-api.controller';
import { MerchantWebhooksService } from './merchant-webhooks.service';

@Module({
  imports: [AuthModule, RedisModule, PlatformPlansModule, MongooseModule.forFeature([
    { name: WebhookSubscription.name, schema: WebhookSubscriptionSchema },
    { name: WebhookDelivery.name, schema: WebhookDeliverySchema },
    { name: ApiToken.name, schema: ApiTokenSchema },
  ])],
  controllers: [MerchantApiSettingsController, MerchantApiV1Controller],
  providers: [MerchantWebhooksService, ApiTokensService, ApiTokenGuard],
  exports: [MerchantWebhooksService],
})
export class MerchantApiModule {}
