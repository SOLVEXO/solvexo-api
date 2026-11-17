import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';
import { PUBLIC_BROWSE_LIMIT } from './public-throttle';
import { SavedSectionsService } from '../saved-sections/saved-sections.service';

/** Storefront read (no login): what a `saved_section` reference is drawn from. Behind the password-store gate like the other public store routes. */
@ApiTags('Saved sections (public)')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/saved-sections')
export class PublicSavedSectionsController {
  constructor(private readonly service: SavedSectionsService) {}

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId')
  list(@Param('storeId') storeId: string) {
    return this.service.listPublic(storeId);
  }
}
