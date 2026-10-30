import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { ThemeCatalogService } from './theme-catalog.service';
import { AdminThemeCatalogController } from './admin-theme-catalog.controller';
import { PublicThemeCatalogController } from './public-theme-catalog.controller';

@Module({
  // JwtAuthGuard (admin controller) injects RedisService, which only resolves when this module imports RedisModule.
  imports: [RedisModule],
  controllers: [AdminThemeCatalogController, PublicThemeCatalogController],
  providers: [ThemeCatalogService],
  exports: [ThemeCatalogService],
})
export class ThemeCatalogModule {}
