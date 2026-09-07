import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { StoreFaqService } from './store-faq.service';

// Public — no auth. Buyers viewing a storefront (solvexo-app) need this
// store's FAQs without logging in. Own controller, same reasoning as
// PublicStoreBannerController/PublicStorePagesController.
@ApiTags('Store FAQs (public)')
@Controller('api/public/store-faqs')
export class PublicStoreFaqController {
  constructor(private readonly storeFaqService: StoreFaqService) {}

  @Get(':storeId')
  findActiveForStore(@Param('storeId') storeId: string) {
    return this.storeFaqService.findActiveForStore(storeId);
  }
}
