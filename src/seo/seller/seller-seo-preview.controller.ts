/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { DatabaseService } from 'src/database/databaseservice';
import { verifyStoreOwnershipStrict } from 'src/common/store-ownership.util';
import { SeoResolutionService, SeoEntityType } from '../services/seo-resolution.service';

const VALID_ENTITY_TYPES: SeoEntityType[] = ['product', 'category', 'store'];

/**
 * Lets a seller preview exactly what `SeoResolutionService` (the same
 * engine backing the public meta-delivery routes — Phase 1) will render for
 * one of their own entities, before it goes live. Read-only, computed on
 * the fly — no caching bypass needed here since a seller checking a preview
 * after an edit expects to see the freshly-invalidated result anyway.
 */
@ApiTags('Seller SEO — Preview')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/store/:storeId/seo/preview')
export class SellerSeoPreviewController {
  constructor(
    private readonly resolution: SeoResolutionService,
    private readonly db: DatabaseService,
  ) {}

  @Get('schema/:entityType/:entityId')
  async previewSchema(@Req() req: any, @Param('storeId') storeId: string, @Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    await this.assertOwnedEntity(storeId, entityType, entityId, req.user.userId);
    const resolved = await this.resolution.resolve(entityType as SeoEntityType, entityId);
    return { jsonLd: resolved.jsonLd };
  }

  @Get('social/:entityType/:entityId')
  async previewSocial(@Req() req: any, @Param('storeId') storeId: string, @Param('entityType') entityType: string, @Param('entityId') entityId: string) {
    await this.assertOwnedEntity(storeId, entityType, entityId, req.user.userId);
    const resolved = await this.resolution.resolve(entityType as SeoEntityType, entityId);
    return {
      ogTitle: resolved.ogTitle,
      ogDescription: resolved.ogDescription,
      ogImage: resolved.ogImage,
      twitterCard: resolved.twitterCard,
      url: resolved.url,
    };
  }

  private async assertOwnedEntity(storeId: string, entityType: string, entityId: string, sellerId: string) {
    if (!VALID_ENTITY_TYPES.includes(entityType as SeoEntityType)) {
      throw new BadRequestException(`entityType must be one of: ${VALID_ENTITY_TYPES.join(', ')}`);
    }
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    if (entityType === 'product') {
      const product = await this.db.repositories.productModel.findOne({ _id: entityId, storeId }).lean();
      if (!product) throw new BadRequestException('Product does not belong to this store.');
    }
    // 'store' entityId is expected to equal :storeId itself; 'category' has no per-store ownership concept (platform-owned).
  }
}
