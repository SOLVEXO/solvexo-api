/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminModerationController } from './admin-moderation.controller';
import { AdminModerationService } from './admin-moderation.service';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [AdminModerationController],
  providers: [AdminModerationService],
  exports: [AdminModerationService],
})
export class AdminModerationModule {}
