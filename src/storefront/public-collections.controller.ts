/* eslint-disable prettier/prettier */
import { Controller, Get, Param, UseInterceptors, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PublicCache, PublicCacheInterceptor } from './public-cache.interceptor';
import { Throttle } from '@nestjs/throttler';
import { PUBLIC_BROWSE_LIMIT } from './public-throttle';
import { CollectionsService } from '../collections/collections.service';

@ApiTags('Public Collections')
@Throttle(PUBLIC_BROWSE_LIMIT)
@Controller('api/public/collections')
export class PublicCollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId')
  list(@Param('storeId') storeId: string) {
    return this.collectionsService.listPublic(storeId);
  }

  @UseInterceptors(PublicCacheInterceptor)
  @PublicCache(15)
  @Get(':storeId/:slugOrId')
  getBySlug(@Param('storeId') storeId: string, @Param('slugOrId') slugOrId: string, @Query('locale') locale?: string) {
    return this.collectionsService.getPublicBySlug(storeId, slugOrId, locale);
  }
}
