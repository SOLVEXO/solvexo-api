import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BannersController } from './banner.controller';
import { BannersService } from './banner.service';
import { RedisModule } from 'src/redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { MediaLibraryModule } from '../media-library/media-library.module';

@Module({
  imports: [ConfigModule, RedisModule, AdminConfigModule, MediaLibraryModule],
  controllers: [BannersController],
  providers: [BannersService],
  exports: [BannersService],
})
export class BannersModule {}
