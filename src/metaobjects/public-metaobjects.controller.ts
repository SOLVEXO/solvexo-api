/* eslint-disable prettier/prettier */
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MetaobjectsService } from './metaobjects.service';

// Public — no auth. A store's metaobject content (e.g. a "Team Member" list)
// is public storefront data, same visibility as its products/pages. The
// real consumer: a `metaobject_list` storefront section (see
// `sectionRegistry.ts`) fetches this to render a themed grid of entries.
@ApiTags('Metaobjects (public)')
@Controller('api/public/metaobjects')
export class PublicMetaobjectsController {
  constructor(private readonly metaobjectsService: MetaobjectsService) {}

  @Get(':storeId/definitions')
  getDefinitions(@Param('storeId') storeId: string) {
    return this.metaobjectsService.getPublicDefinitions(storeId);
  }

  @Get(':storeId/:type')
  getEntriesByType(@Param('storeId') storeId: string, @Param('type') type: string) {
    return this.metaobjectsService.getPublicEntriesByType(storeId, type);
  }

  @Get(':storeId/entry/:entryId')
  getEntry(@Param('storeId') storeId: string, @Param('entryId') entryId: string) {
    return this.metaobjectsService.getPublicEntry(storeId, entryId);
  }
}
