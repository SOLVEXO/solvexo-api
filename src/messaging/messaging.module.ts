/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { MessagingController } from './messaging.controller';
import { MessagingService } from './messaging.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { UploadModule } from 'src/upload/upload.module';

@Module({
  imports: [AuthModule, RedisModule, UploadModule],
  controllers: [MessagingController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
