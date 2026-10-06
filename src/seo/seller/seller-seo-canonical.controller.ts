/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { PermissionsGuard } from '@/auth/guards/permissions.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { RequirePermission } from '@/auth/decorators/require-permission.decorator';
import { DatabaseService } from '@/database/databaseservice';
import { EntitlementsService } from '@/platform-plans/entitlements.service';
import { verifyStoreOwnershipStrict } from '@/common/store-ownership.util';
import { actingSellerId } from '@/common/acting-seller-id.util';
import { SeoCanonicalService } from '../services/seo-canonical.service';
import { CreateCanonicalRuleDto } from '../dto/create-canonical-rule.dto';
import { UpdateCanonicalRuleDto } from '../dto/update-canonical-rule.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';
import { Res, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv, runBulkImport } from '../../common/bulk-import/bulk-import.util';
import { CANONICAL_COLUMNS, canonicalFileDedupeKey, makeCanonicalRowHandler } from '../canonical-rules-bulk-import';

@ApiTags('Seller SEO — Canonical Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/store/:storeId/seo/canonical-rules')
export class SellerSeoCanonicalController {
  constructor(
    private readonly canonical: SeoCanonicalService,
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private async assertAccess(storeId: string, sellerId: string) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, sellerId);
    await this.entitlements.assertFeatureAllowed(storeId, 'customRedirectsAllowed', 'Custom canonical rules');
  }

  // CSV import. `@Res()` sends the engine's own response shape (the class-level
  // SeoResponseInterceptor would otherwise wrap it a second time).
  @RequirePermission('seo.manage')
  @Get('import-template')
  async importTemplate(@Req() req: any, @Param('storeId') storeId: string, @Res() res: any) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return res.json(buildTemplatePayload('canonical-rules-import-template.csv', CANONICAL_COLUMNS));
  }

  @RequirePermission('seo.manage')
  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importRules(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any, @Res() res: any) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    const actor = { id: req.user.userId, role: req.user.role };
    const result = await runBulkImport({
      text: readUploadedCsv(file),
      columns: CANONICAL_COLUMNS,
      maxRows: 1000,
      label: 'canonical rule',
      fileDedupeKey: canonicalFileDedupeKey,
      handler: makeCanonicalRowHandler((dto) => this.canonical.create(storeId, dto as any, actor)),
    });
    return res.json(result);
  }

  @RequirePermission('seo.manage')
  @Post()
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCanonicalRuleDto) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.canonical.create(storeId, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.view', 'seo.manage')
  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    await verifyStoreOwnershipStrict(this.db.repositories.storeModel, storeId, actingSellerId(req.user));
    return this.canonical.list(storeId, query);
  }

  @RequirePermission('seo.manage')
  @Patch(':id')
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateCanonicalRuleDto) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.canonical.update(storeId, id, dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.manage')
  @Delete(':id')
  async delete(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    await this.assertAccess(storeId, actingSellerId(req.user));
    return this.canonical.delete(storeId, id, { id: req.user.userId, role: req.user.role });
  }
}
