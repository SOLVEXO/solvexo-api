/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { DatabaseService } from '../database/databaseservice';
import { StoreService } from './store.service';
import { TAX_REGION_IMPORT_COLUMNS, importTaxRegionsCsv } from './store-tax-regions-bulk-import';

/**
 * CSV import of Store.taxRegions. Writes go through StoreService.updateStore
 * (same validation/ownership as Settings → save). `settings.taxes.manage` is
 * required (Shopify's "Manage taxes"), stricter than update-store's
 * `settings.general.manage` which currently lets staff edit taxRegions.
 */
@ApiTags('Store tax regions import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.taxes.manage')
@Controller('api/store/:storeId/tax-regions')
export class StoreTaxRegionsImportController {
  constructor(
    private readonly storeService: StoreService,
    private readonly databaseService: DatabaseService,
  ) {}

  @Get('import-template')
  importTemplate() {
    return buildTemplatePayload('tax-regions-import-template.csv', TAX_REGION_IMPORT_COLUMNS);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    const sellerId = actingSellerId(req.user);
    const text = readUploadedCsv(file);
    const store: any = await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    return importTaxRegionsCsv(
      {
        existing: store.taxRegions ?? [],
        save: (regions) => this.storeService.updateStore(sellerId, storeId, { taxRegions: regions }),
      },
      text,
    );
  }
}
