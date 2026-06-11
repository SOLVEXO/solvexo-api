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

@Module({
   imports: [AuthModule, RedisModule], 
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
