/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { PaymentGatewayService } from './payment-gateway/payment-gateway.service';
import { CurrencyDisplayService } from './currency-display.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsService,
    PaymentGatewayService,
    CurrencyDisplayService,
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
