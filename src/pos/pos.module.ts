/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { AuthModule } from 'src/auth/auth.module';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  imports: [AuthModule, RedisModule],
  controllers: [PosController],
  providers: [PosService],
})
export class PosModule {}
