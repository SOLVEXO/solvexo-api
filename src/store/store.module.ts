import { Module } from '@nestjs/common';
import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { AuthModule } from '@/auth/auth.module';
import { RedisModule } from '@/redis/redis.module';
import { AdminConfigModule } from '@/admin-config/admin-config.module';
import { MarketingModule } from '@/marketing/marketing.module';
import { UploadModule } from '@/upload/upload.module';
import { StoreThemeModule } from '../store-theme/store-theme.module';
import { StorePagesModule } from '../store-pages/store-pages.module';
import { CollectionsModule } from '../collections/collections.module';

@Module({
  imports: [AuthModule, RedisModule, AdminConfigModule, MarketingModule, UploadModule, StoreThemeModule, StorePagesModule, CollectionsModule],
  controllers: [StoreController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreModule {}
