/* eslint-disable prettier/prettier */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BannersController } from './banner.controller';
import { BannersService } from './banner.service';
import { RedisModule } from 'src/redis/redis.module';

@Module({
  imports: [ConfigModule, RedisModule],
  controllers: [BannersController],
  providers: [BannersService],
  exports: [BannersService],
})
export class BannersModule {}
