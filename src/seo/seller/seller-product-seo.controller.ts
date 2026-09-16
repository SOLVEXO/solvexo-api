/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Post, Param, Body, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { SeoContentService } from '../services/seo-content.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { BulkApplyProductTemplateDto } from '../dto/bulk-apply-template.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Seller SEO — Product Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/products')
export class SellerProductSeoController {
  constructor(
    private readonly seoContent: SeoContentService,
    private readonly db: DatabaseService,
  ) {}

  // Static routes registered before the `:productId` catch-all, same discipline used throughout this codebase (Orders/POS).
  @RequirePermission('seo.manage')
  @Post('bulk-apply-template')
  async bulkApply(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: BulkApplyProductTemplateDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.bulkApplyProductTemplate(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get('export')
  async exportCsv(@Req() req: any, @Param('storeId') storeId: string, @Res() res: Response) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    const csv = await this.seoContent.exportProductSeoCsv(storeId);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="product-seo-${storeId}.csv"`);
    res.send(csv);
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.listProductSeo(storeId, query);
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get(':productId')
  async getOne(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.getProductSeo(storeId, productId);
  }

  @RequirePermission('seo.manage')
  @Patch(':productId')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('productId') productId: string, @Body() dto: UpdateSeoMetaDto) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.seoContent.updateProductSeo(storeId, productId, dto, { id: req.user.userId, role: req.user.role });
  }
}
