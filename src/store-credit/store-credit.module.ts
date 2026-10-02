/* eslint-disable prettier/prettier */
import { Global, Module } from '@nestjs/common';
import { StoreCreditController } from './store-credit.controller';
import { StoreCreditService } from './store-credit.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

// @Global() so checkout / payment / orders / scheduler can inject StoreCreditService without each
// importing this module (same pattern as CommissionRulesModule). AuthModule + RedisModule are what
// every module whose controller uses JwtAuthGuard needs (see GiftCardsModule's comment).
@Global()
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [StoreCreditController],
  providers: [StoreCreditService],
  exports: [StoreCreditService],
})
export class StoreCreditModule {}
