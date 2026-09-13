/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { TrackingPixelsController } from './tracking-pixels.controller';
import { TrackingPixelsService } from './tracking-pixels.service';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';

// RedisModule alongside AuthModule — required by every module whose
// controller uses JwtAuthGuard (see GiftCardsModule's own doc comment).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [TrackingPixelsController],
  providers: [TrackingPixelsService],
  exports: [TrackingPixelsService],
})
export class TrackingPixelsModule {}
