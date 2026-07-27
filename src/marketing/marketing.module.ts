import { Module } from '@nestjs/common';
import { MarketingController } from './marketing.controller';
import { PublicMarketingController } from './public-marketing.controller';
import { MarketingService } from './marketing.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [MarketingController, PublicMarketingController],
  providers: [MarketingService],
  exports: [MarketingService],
})
export class MarketingModule {}
