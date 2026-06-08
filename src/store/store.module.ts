/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule], 
  controllers: [StoreController],
  providers: [StoreService],
})
export class StoreModule {}
