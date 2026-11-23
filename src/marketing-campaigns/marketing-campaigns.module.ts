/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { MarketingCampaignsController } from './marketing-campaigns.controller';
import { MarketingCampaignsService } from './marketing-campaigns.service';

// AuthModule + RedisModule: the controller uses JwtAuthGuard (same note as CustomerSegmentsModule).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [MarketingCampaignsController],
  providers: [MarketingCampaignsService],
  exports: [MarketingCampaignsService],
})
export class MarketingCampaignsModule {}
