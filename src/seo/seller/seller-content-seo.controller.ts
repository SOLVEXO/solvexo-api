/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { SeoContentService } from '../services/seo-content.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

class UpdatePageSeoDto {
  metaTitle?: string;
  metaDescription?: string;
  ogImage?: string;
  noindex?: boolean;
}

class UpdateCollectionSeoDto {
  metaTitle?: string | null;
  metaDescription?: string | null;
}

// Categories are platform-owned/admin-curated (see master doc §5.2) — sellers
// only ever *view* category meta here, never edit it (editing is
// api/admin/seo/categories/:id). Collections and page-builder pages, by
// contrast, are fully store-owned and editable.
@ApiTags('Seller SEO — Categories & Pages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/content')
export class SellerContentSeoController {
  constructor(
    private readonly seoContent: SeoContentService,
    private readonly db: DatabaseService,
  ) {}

  @RequirePermission('seo.view', 'seo.manage')
  @Get('categories')
  async listCategories(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.listStoreCategoriesSeo(storeId);
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('collections')
  async listCollections(@Req() req: any, @Param('storeId') storeId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.listStoreCollectionsSeo(storeId);
  }

  @RequirePermission('seo.manage')
  @Patch('collections/:collectionId')
  async updateCollection(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string, @Body() dto: UpdateCollectionSeoDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.updateCollectionSeo(storeId, collectionId, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('pages/:pageId')
  async getPage(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.getPageSeo(storeId, pageId);
  }

  @RequirePermission('seo.manage')
  @Patch('pages/:pageId')
  async updatePage(@Req() req: any, @Param('storeId') storeId: string, @Param('pageId') pageId: string, @Body() dto: UpdatePageSeoDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.updatePageSeo(storeId, pageId, dto, { id: req.user.userId, role: req.user.role });
  }
}
