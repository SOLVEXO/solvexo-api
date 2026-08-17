import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StorePagesService } from './store-pages.service';

// Public — no auth. Backs the real storefront routes: `/:slug` (home),
// `/:slug/pages/:pageSlug` (custom page). Own controller, same reasoning as
// PublicStoreBannerController/PublicStoreThemeController.
@ApiTags('Store Pages (public)')
@Controller('api/public/store-pages')
export class PublicStorePagesController {
  constructor(private readonly storePagesService: StorePagesService) {}

  @Get(':storeId/home')
  getHome(@Param('storeId') storeId: string) {
    return this.storePagesService.getPublicHome(storeId);
  }

  @Get(':storeId/list')
  list(@Param('storeId') storeId: string) {
    return this.storePagesService.listPublicPages(storeId);
  }

  @Get(':storeId/page/:slug')
  getPage(@Param('storeId') storeId: string, @Param('slug') slug: string) {
    return this.storePagesService.getPublicPage(storeId, slug);
  }
}
