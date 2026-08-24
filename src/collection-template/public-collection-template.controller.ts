import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CollectionTemplateService } from './collection-template.service';

// Public — no auth. Backs the real storefront route `/collections/:slugOrId`.
// Same reasoning/shape as `PublicStorePagesController`.
@ApiTags('Collection Template (public)')
@Controller('api/public/collection-template')
export class PublicCollectionTemplateController {
  constructor(
    private readonly collectionTemplateService: CollectionTemplateService,
  ) {}

  @Get(':storeId')
  get(@Param('storeId') storeId: string) {
    return this.collectionTemplateService.getPublic(storeId);
  }
}
