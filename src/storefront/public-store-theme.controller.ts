import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_BROWSE_LIMIT } from './public-throttle';
import { StoreThemeService } from '../store-theme/store-theme.service';

// Public — no auth. A buyer visiting a storefront needs its navbar/footer/theme
// without logging in. Own controller, same reasoning as PublicStoreBannerController.
// Imported-Liquid-theme public routes (render/asset) live in ../themes/liquid/public-liquid-theme.controller.ts.
@ApiTags('Store Theme (public)')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/store-theme')
export class PublicStoreThemeController {
  constructor(private readonly storeThemeService: StoreThemeService) {}

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.storeThemeService.getPublic(storeId);
  }

  // Real, shareable "see this before it's live" link — see `PreviewToken`'s
  // schema comment for the scope boundary. Declared as its own static
  // segment (`preview/:token`) ahead of nothing here since `:storeId` is
  // the only other route on this controller and doesn't collide.
  @Get(':storeId/preview/:token')
  getPreview(@Param('storeId') storeId: string, @Param('token') token: string) {
    return this.storeThemeService.getPreviewByToken(storeId, token);
  }
}
