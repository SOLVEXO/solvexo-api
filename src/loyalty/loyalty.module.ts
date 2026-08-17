import { Global, Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { RedisModule } from '../redis/redis.module';

// Global (like ActivityLogModule) so OrdersService/RatingService/FinanceService can inject
// LoyaltyService without adding it to their own imports. Deliberately no AuthModule import —
// guards here only need RedisService + Reflector, same reasoning as ActivityLogModule.
@Global()
@Module({
  imports: [RedisModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
