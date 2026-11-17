import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';
import { PUBLIC_BROWSE_LIMIT } from './public-throttle';
import { StoreSectionDefsService } from '../store-section-defs/store-section-defs.service';

/** Storefront read (no login): the layouts of the store's own (`my.*`) sections. Behind the password-store gate like the other public store routes. */
@ApiTags('Section builder (public)')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/store-section-defs')
export class PublicStoreSectionDefsController {
  constructor(private readonly service: StoreSectionDefsService) {}

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId')
  list(@Param('storeId') storeId: string) {
    return this.service.listPublic(storeId);
  }
}
