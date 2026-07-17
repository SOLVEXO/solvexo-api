/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
