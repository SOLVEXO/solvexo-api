/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminMarketingController } from './admin-marketing.controller';
import { AdminMarketingService } from './admin-marketing.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AdminMarketingController],
  providers: [AdminMarketingService],
  exports: [AdminMarketingService],
})
export class AdminMarketingModule {}
