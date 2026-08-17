import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StoreBannerService } from './store-banner.service';

// Public — no auth. Buyers viewing a storefront need to see its active banners
// without logging in. Deliberately its own controller (not nested under the
// seller-guarded 'api/store-banner/:storeId' prefix), same reasoning as
// PublicMarketingController.
@ApiTags('Store Banners (public)')
@Controller('api/public/store-banners')
export class PublicStoreBannerController {
  constructor(private readonly storeBannerService: StoreBannerService) {}

  @Get(':storeId')
  findActiveForStore(@Param('storeId') storeId: string) {
    return this.storeBannerService.findActiveForStore(storeId);
  }
}
