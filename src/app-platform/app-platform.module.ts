import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { PlatformPlansModule } from '../platform-plans/platform-plans.module';
import { ApiToken, ApiTokenSchema, WebhookSubscription, WebhookSubscriptionSchema } from '../merchant-api/merchant-api.schema';
import { AppAuthCode, AppAuthCodeSchema, AppDefinition, AppDefinitionSchema, AppInstall, AppInstallSchema } from './app.schema';
import { AdminAppPlatformController, AppOAuthController, SellerAppPlatformController } from './app-platform.controller';
import { AppPlatformService } from './app-platform.service';

@Module({
  imports: [
    AuthModule, RedisModule, PlatformPlansModule,
    MongooseModule.forFeature([
      { name: AppDefinition.name, schema: AppDefinitionSchema },
      { name: AppInstall.name, schema: AppInstallSchema },
      { name: AppAuthCode.name, schema: AppAuthCodeSchema },
      { name: ApiToken.name, schema: ApiTokenSchema },
      { name: WebhookSubscription.name, schema: WebhookSubscriptionSchema },
    ]),
  ],
  controllers: [AdminAppPlatformController, SellerAppPlatformController, AppOAuthController],
  providers: [AppPlatformService],
  exports: [AppPlatformService],
})
export class AppPlatformModule {}
