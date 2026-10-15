import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { AdminConfigModule } from '../admin-config/admin-config.module';
import { ContentVersioningModule } from '../common/content-versioning/content-versioning.module';
import { MenusModule } from '../menus/menus.module';
import { ThemeCatalogModule } from '../theme-catalog/theme-catalog.module';
import { StoreThemeController } from './store-theme.controller';
import { PublicStoreThemeController } from './public-store-theme.controller';
import { StoreThemeService } from './store-theme.service';
import { LiquidThemeController } from '../themes/liquid/liquid-theme.controller';
import { PublicLiquidThemeController } from '../themes/liquid/public-liquid-theme.controller';
import { ThemePackageService } from '../themes/liquid/theme-package.service';
import { ThemeImportProcessor } from '../themes/liquid/theme-import.processor';

// One module registers BOTH the native section/block theme editor (this folder) and the imported-Liquid-theme
// ZIP lifecycle (../themes/liquid/) — they share the `api/store-theme` route prefix and permission, so the
// frontend keeps calling one surface, even though the two implementations live in separate folders.
@Module({
  imports: [
    AuthModule,
    RedisModule,
    AdminConfigModule,
    ContentVersioningModule,
    MenusModule,
    ThemeCatalogModule,
  ],
  controllers: [StoreThemeController, PublicStoreThemeController, LiquidThemeController, PublicLiquidThemeController],
  providers: [StoreThemeService, ThemePackageService, ThemeImportProcessor],
  exports: [StoreThemeService],
})
export class StoreThemeModule {}
