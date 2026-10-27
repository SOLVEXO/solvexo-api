import { Controller, Get, Param, UseInterceptors, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_BROWSE_LIMIT } from './public-throttle';
import { StorePagesService } from '../store-pages/store-pages.service';

// Public — no auth. Backs the real storefront routes: `/:slug` (home),
// `/:slug/pages/:pageSlug` (custom page). Own controller, same reasoning as
// PublicStoreBannerController/PublicStoreThemeController.
@ApiTags('Store Pages (public)')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/store-pages')
export class PublicStorePagesController {
  constructor(private readonly storePagesService: StorePagesService) {}

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId/home')
  getHome(@Param('storeId') storeId: string) {
    return this.storePagesService.getPublicHome(storeId);
  }

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId/list')
  list(@Param('storeId') storeId: string) {
    return this.storePagesService.listPublicPages(storeId);
  }

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId/page/:slug')
  getPage(@Param('storeId') storeId: string, @Param('slug') slug: string, @Query('locale') locale?: string) {
    return this.storePagesService.getPublicPage(storeId, slug, locale);
  }
}
