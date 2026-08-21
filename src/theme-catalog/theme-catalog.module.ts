import { Module } from '@nestjs/common';
import { ThemeCatalogService } from './theme-catalog.service';
import { AdminThemeCatalogController } from './admin-theme-catalog.controller';
import { PublicThemeCatalogController } from './public-theme-catalog.controller';

@Module({
  controllers: [AdminThemeCatalogController, PublicThemeCatalogController],
  providers: [ThemeCatalogService],
  exports: [ThemeCatalogService],
})
export class ThemeCatalogModule {}
