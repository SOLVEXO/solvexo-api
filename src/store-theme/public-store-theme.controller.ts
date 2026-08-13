import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StoreThemeService } from './store-theme.service';

// Public — no auth. A buyer visiting a storefront needs its navbar/footer/theme
// without logging in. Own controller, same reasoning as PublicStoreBannerController.
@ApiTags('Store Theme (public)')
@Controller('api/public/store-theme')
export class PublicStoreThemeController {
  constructor(private readonly storeThemeService: StoreThemeService) {}

  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.storeThemeService.getPublic(storeId);
  }
}
