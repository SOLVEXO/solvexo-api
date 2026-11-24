import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ApiIdempotency, ApiIdempotencySchema, ApiToken, ApiTokenSchema, WebhookDelivery, WebhookDeliverySchema, WebhookSubscription, WebhookSubscriptionSchema } from './merchant-api.schema';
import { ApiTokenGuard, ApiTokensService } from './api-tokens.service';
import { MerchantApiSettingsController, MerchantApiV1Controller } from './merchant-api.controller';
import { MerchantWebhooksService } from './merchant-webhooks.service';
import { ApiWritesService } from './api-writes.service';
import { ApiReadsService } from './api-reads.service';
import { MerchantApiDocsController } from './merchant-api-docs.controller';

@Module({
  imports: [AuthModule, RedisModule, PlatformPlansModule, InventoryModule, MongooseModule.forFeature([
    { name: WebhookSubscription.name, schema: WebhookSubscriptionSchema },
    { name: WebhookDelivery.name, schema: WebhookDeliverySchema },
    { name: ApiToken.name, schema: ApiTokenSchema },
    { name: ApiIdempotency.name, schema: ApiIdempotencySchema },
  ])],
  controllers: [MerchantApiDocsController, MerchantApiSettingsController, MerchantApiV1Controller],
  providers: [MerchantWebhooksService, ApiTokensService, ApiTokenGuard, ApiWritesService, ApiReadsService],
  exports: [MerchantWebhooksService],
})
export class MerchantApiModule {}
