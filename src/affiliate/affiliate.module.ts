/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AffiliateController } from './affiliate.controller';
import { AffiliateService } from './affiliate.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

// RedisModule alongside AuthModule — required by every module whose
// controller uses JwtAuthGuard (see GiftCardsModule's own doc comment).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AffiliateController],
  providers: [AffiliateService],
  exports: [AffiliateService],
})
export class AffiliateModule {}
