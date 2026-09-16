/* eslint-disable prettier/prettier */
import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req,
  UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { verifyStoreOwnershipStrict } from '../common/store-ownership.util';
import { DatabaseService } from '../database/databaseservice';
import { MediaLibraryService } from './media-library.service';
import { UpdateMediaAssetDto } from './dto/update-media-asset.dto';
import { ListMediaAssetsDto } from './dto/list-media-assets.dto';

const LIBRARY_UPLOAD = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

@ApiTags('Media Library')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api/media-library')
export class MediaLibraryController {
  constructor(
    private readonly mediaLibraryService: MediaLibraryService,
    private readonly databaseService: DatabaseService,
  ) {}

  // Returns the caller's own previously-uploaded promotional creatives — admin
  // sees admin-owned assets, seller sees their own, scoped by role+userId.
  // Kept exactly as-is for the pre-existing promotional-creative picker —
  // deliberately NOT staff-enabled (it's not store-scoped at all, so there's
  // no permission boundary that would make sense here).
  @Get()
  async list(@Req() req: any) {
    const ownerType: 'admin' | 'seller' = req.user.role === 'admin' ? 'admin' : 'seller';
    const assets = await this.mediaLibraryService.listForOwner(ownerType, req.user.userId);
    return { success: true, data: assets };
  }

  // ── Files Library (real, per-store) ───────────────────────────────────────

  @Get(':storeId')
  @Roles('seller', 'staff')
  @RequirePermission('files.manage')
  @UseGuards(RolesGuard, PermissionsGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async browse(@Req() req: any, @Param('storeId') storeId: string, @Query() query: ListMediaAssetsDto) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, actingSellerId(req.user));
    const result = await this.mediaLibraryService.listForStore(storeId, query);
    return { success: true, data: result };
  }

  @Post(':storeId/upload')
  @Roles('seller', 'staff')
  @RequirePermission('files.manage')
  @UseGuards(RolesGuard, PermissionsGuard)
  @UseInterceptors(LIBRARY_UPLOAD)
  async upload(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { altText?: string; tags?: string },
  ) {
    const sellerId = actingSellerId(req.user);
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, sellerId);
    const tags = body.tags ? body.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const result = await this.mediaLibraryService.uploadAndTrack(file, 'seller', sellerId, {
      storeId, altText: body.altText, tags,
    });
    return { success: true, data: result };
  }

  @Patch(':storeId/:assetId')
  @Roles('seller', 'staff')
  @RequirePermission('files.manage')
  @UseGuards(RolesGuard, PermissionsGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('assetId') assetId: string, @Body() dto: UpdateMediaAssetDto) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, actingSellerId(req.user));
    const asset = await this.mediaLibraryService.updateMeta(storeId, assetId, dto);
    return { success: true, data: asset };
  }

  @Get(':storeId/:assetId/usage')
  @Roles('seller', 'staff')
  @RequirePermission('files.manage')
  @UseGuards(RolesGuard, PermissionsGuard)
  async usage(@Req() req: any, @Param('storeId') storeId: string, @Param('assetId') assetId: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, actingSellerId(req.user));
    const usage = await this.mediaLibraryService.checkUsage(storeId, assetId);
    return { success: true, data: usage };
  }

  @Delete(':storeId/:assetId')
  @Roles('seller', 'staff')
  @RequirePermission('files.manage')
  @UseGuards(RolesGuard, PermissionsGuard)
  async remove(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('assetId') assetId: string,
    @Query('force') force?: string,
  ) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, actingSellerId(req.user));
    await this.mediaLibraryService.deleteAsset(storeId, assetId, force === 'true');
    return { success: true, message: 'File deleted.' };
  }
}
