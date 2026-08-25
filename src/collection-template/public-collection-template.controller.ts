import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CollectionTemplateService } from './collection-template.service';
import { ResourceTemplateType } from './schemas/collection-template.schema';

// Public — no auth. Backs the real storefront routes `/collections/:slugOrId`
// and `/product/:slug` (surrounding-sections template resolution). Same
// reasoning/shape as `PublicStorePagesController`.
@ApiTags('Resource Templates (public)')
@Controller('api/public/collection-template')
export class PublicCollectionTemplateController {
  constructor(
    private readonly collectionTemplateService: CollectionTemplateService,
  ) {}

  @Get(':storeId')
  get(@Param('storeId') storeId: string, @Query('resourceType') resourceType?: string, @Query('templateKey') templateKey?: string) {
    return this.collectionTemplateService.getPublic(storeId, (resourceType as ResourceTemplateType) ?? 'collection', templateKey);
  }
}
