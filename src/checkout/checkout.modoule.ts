// import { Module } from '@nestjs/common';
// import { checkoutService } from './checkout.service';
// import { checkoutController } from './checkout.controller';
// import { DatabaseModule } from 'src/database/database.module';
// import { AuthModule } from 'src/auth/auth.module';
// import { RedisModule } from 'src/redis/redis.module';

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
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { MarketingModule } from 'src/marketing/marketing.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';
import { ExchangeRateModule } from 'src/exchange-rate/exchange-rate.module';

@Module({
  imports: [AuthModule, RedisModule, MarketingModule, AdminConfigModule, ExchangeRateModule],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
