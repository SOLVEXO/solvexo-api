// import { Module } from '@nestjs/common';
// import { checkoutService } from './checkout.service';
// import { checkoutController } from './checkout.controller';
// import { DatabaseModule } from '@/database/database.module';
// import { AuthModule } from '@/auth/auth.module';
// import { RedisModule } from '@/redis/redis.module';

// @Module({
//   imports: [AuthModule, RedisModule],
//   controllers: [checkoutController],
//   providers: [checkoutService],
//   exports: [checkoutService],
// })
// export class checkoutModule {}

import { Module } from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { CheckoutController } from './checkout.controller';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { MarketingModule } from '@/marketing/marketing.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { ExchangeRateModule } from '@/exchange-rate/exchange-rate.module';
import { GiftCardsModule } from '@/gift-cards/gift-cards.module';
import { DiscountsModule } from '@/discounts/discounts.module';

@Module({
  imports: [AuthModule, RedisModule, MarketingModule, AdminConfigModule, ExchangeRateModule, GiftCardsModule, DiscountsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
