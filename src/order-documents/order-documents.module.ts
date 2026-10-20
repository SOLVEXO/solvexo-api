/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { OrderDocumentsController } from './order-documents.controller';
import { OrderDocumentsService } from './order-documents.service';

// AuthModule + RedisModule: JwtAuthGuard needs them (see NotificationsModule's note).
@Module({
  imports: [AuthModule, RedisModule],
  controllers: [OrderDocumentsController],
  providers: [OrderDocumentsService],
})
export class OrderDocumentsModule {}
