/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { StoreLocationService } from './store-location.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from 'src/admin-config/admin-config.module';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule],
  controllers: [PosController],
  providers: [PosService, StoreLocationService],
})
export class PosModule {}
