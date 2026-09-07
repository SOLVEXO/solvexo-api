import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { ContentVersioningModule } from '../common/content-versioning/content-versioning.module';
import { StoreThemeController } from './store-theme.controller';
import { PublicStoreThemeController } from './public-store-theme.controller';
import { StoreThemeService } from './store-theme.service';

@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminConfigModule,
    ContentVersioningModule,
  ],
  controllers: [StoreThemeController, PublicStoreThemeController],
  providers: [StoreThemeService],
  exports: [StoreThemeService],
})
export class StoreThemeModule {}
