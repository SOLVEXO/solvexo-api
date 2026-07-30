import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { MediaLibraryModule } from '../media-library/media-library.module';
import { StoreBannerController } from './store-banner.controller';
import { PublicStoreBannerController } from './public-store-banner.controller';
import { StoreBannerService } from './store-banner.service';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, MediaLibraryModule],
  controllers: [StoreBannerController, PublicStoreBannerController],
  providers: [StoreBannerService],
  exports: [StoreBannerService],
})
export class StoreBannerModule {}
