/* eslint-disable prettier/prettier */
import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { MetafieldsService } from './metafields.service';
import type { MetafieldOwnerResource } from './schemas/metafield-definition.schema';

// Public — no auth. Not yet consumed by any theme section (Dynamic Sources —
// binding a section/block field directly to a metafield in the editor — is
// a disclosed follow-up, not built in this pass), but the read side is real
// and ready for it: a future section renderer can call this exactly the way
// it already calls `GET /api/public/products/:id` for the product itself.
@ApiTags('Metafields (public)')
@Controller('api/public/metafields')
export class PublicMetafieldsController {
  constructor(private readonly metafieldsService: MetafieldsService) {}

  @Get(':storeId/:ownerResource/:ownerId')
  get(
    @Param('storeId') storeId: string,
    @Param('ownerResource') ownerResource: MetafieldOwnerResource,
    @Param('ownerId') ownerId: string,
  ) {
    return this.metafieldsService.getPublicValues(storeId, ownerResource, ownerId);
  }
}
