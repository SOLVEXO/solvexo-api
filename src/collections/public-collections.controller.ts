/* eslint-disable prettier/prettier */
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';

@ApiTags('Public Collections')
@Controller('api/public/collections')
export class PublicCollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get(':storeId')
  list(@Param('storeId') storeId: string) {
    return this.collectionsService.listPublic(storeId);
  }

  @Get(':storeId/:slugOrId')
  getBySlug(@Param('storeId') storeId: string, @Param('slugOrId') slugOrId: string) {
    return this.collectionsService.getPublicBySlug(storeId, slugOrId);
  }
}
