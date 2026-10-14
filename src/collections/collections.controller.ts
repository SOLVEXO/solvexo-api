/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Req, UseGuards, UsePipes, ValidationPipe, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { COLLECTION_IMPORT_COLUMNS } from './collections-bulk-import';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { CollectionsService } from './collections.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateCollectionDto } from './dto/create-collection.dto';
import { UpdateCollectionDto } from './dto/update-collection.dto';
import { UpdateCollectionProductsDto } from './dto/update-collection-products.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
@ApiTags('Collections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('collections.manage')
  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCollectionDto) {
    return this.collectionsService.create(storeId, actingSellerId(req.user), dto);
  }

  // Static import routes MUST stay above the `:storeId/:collectionId` routes.
  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('collections.manage')
  @Get(':storeId/import-template')
  importTemplate() {
    return buildTemplatePayload('collections-import-template.csv', COLLECTION_IMPORT_COLUMNS);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('collections.manage')
  @Post(':storeId/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importCollections(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.collectionsService.importCsv(storeId, actingSellerId(req.user), readUploadedCsv(file));
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('products.view', 'collections.manage')
  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.collectionsService.listForSeller(storeId, actingSellerId(req.user));
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('products.view', 'collections.manage')
  @Get(':storeId/:collectionId')
  get(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string) {
    return this.collectionsService.getForSeller(storeId, actingSellerId(req.user), collectionId);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('collections.manage')
  @Patch(':storeId/:collectionId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string, @Body() dto: UpdateCollectionDto) {
    return this.collectionsService.update(storeId, actingSellerId(req.user), collectionId, dto);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('collections.manage')
  @Patch(':storeId/:collectionId/products')
  updateProducts(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string, @Body() dto: UpdateCollectionProductsDto) {
    return this.collectionsService.updateProducts(storeId, actingSellerId(req.user), collectionId, dto);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('collections.manage')
  @Delete(':storeId/:collectionId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('collectionId') collectionId: string) {
    return this.collectionsService.delete(storeId, actingSellerId(req.user), collectionId);
  }
}
