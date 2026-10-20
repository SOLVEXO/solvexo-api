/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StoreBadgesController } from './store-badges.controller';
import { StoreBadgesService } from './store-badges.service';

// AuthModule + RedisModule: JwtAuthGuard needs them (see NotificationsModule's note).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [StoreBadgesController],
  providers: [StoreBadgesService],
})
export class StoreBadgesModule {}
