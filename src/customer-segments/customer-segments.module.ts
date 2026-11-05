/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { StoreModule } from '../store/store.module';
import { CustomerSegmentsController } from './customer-segments.controller';
import { CustomerSegmentsService } from './customer-segments.service';

// AuthModule + RedisModule: the controller uses JwtAuthGuard (see NotificationsModule's note).
@Module({
  imports: [AuthModule, RedisModule, StoreModule],
  controllers: [CustomerSegmentsController],
  providers: [CustomerSegmentsService],
  exports: [CustomerSegmentsService],
})
export class CustomerSegmentsModule {}
