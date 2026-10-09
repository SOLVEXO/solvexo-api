/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { StorefrontAnalyticsController } from './storefront-analytics.controller';
import { StorefrontAnalyticsService } from './storefront-analytics.service';

@Module({
  // AuthModule + RedisModule: OptionalJwtAuthGuard resolves its deps from this module (same as ProductViewsModule).
  imports: [AuthModule, RedisModule],
  controllers: [StorefrontAnalyticsController],
  providers: [StorefrontAnalyticsService],
  exports: [StorefrontAnalyticsService],
})
export class StorefrontAnalyticsModule {}
