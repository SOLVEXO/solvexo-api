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
import { Roles } from '../auth/decorators/roles.decorator';
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
  // Kept exactly as-is for the pre-existing promotional-creative picker.
  @Get()
  async list(@Req() req: any) {
    const ownerType: 'admin' | 'seller' = req.user.role === 'admin' ? 'admin' : 'seller';
    const assets = await this.mediaLibraryService.listForOwner(ownerType, req.user.userId);
    return { success: true, data: assets };
  }

  // ── Files Library (real, per-store) ───────────────────────────────────────

  @Get(':storeId')
  @Roles('seller')
  @UseGuards(RolesGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async browse(@Req() req: any, @Param('storeId') storeId: string, @Query() query: ListMediaAssetsDto) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, req.user.userId);
    const result = await this.mediaLibraryService.listForStore(storeId, query);
    return { success: true, data: result };
  }

  @Post(':storeId/upload')
  @Roles('seller')
  @UseGuards(RolesGuard)
  @UseInterceptors(LIBRARY_UPLOAD)
  async upload(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { altText?: string; tags?: string },
  ) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, req.user.userId);
    const tags = body.tags ? body.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const result = await this.mediaLibraryService.uploadAndTrack(file, 'seller', req.user.userId, {
      storeId, altText: body.altText, tags,
    });
    return { success: true, data: result };
  }

  @Patch(':storeId/:assetId')
  @Roles('seller')
  @UseGuards(RolesGuard)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async update(@Req() req: any, @Param('storeId') storeId: string, @Param('assetId') assetId: string, @Body() dto: UpdateMediaAssetDto) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, req.user.userId);
    const asset = await this.mediaLibraryService.updateMeta(storeId, assetId, dto);
    return { success: true, data: asset };
  }

  @Get(':storeId/:assetId/usage')
  @Roles('seller')
  @UseGuards(RolesGuard)
  async usage(@Req() req: any, @Param('storeId') storeId: string, @Param('assetId') assetId: string) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, req.user.userId);
    const usage = await this.mediaLibraryService.checkUsage(storeId, assetId);
    return { success: true, data: usage };
  }

  @Delete(':storeId/:assetId')
  @Roles('seller')
  @UseGuards(RolesGuard)
  async remove(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('assetId') assetId: string,
    @Query('force') force?: string,
  ) {
    await verifyStoreOwnershipStrict(this.databaseService.repositories.storeModel, storeId, req.user.userId);
    await this.mediaLibraryService.deleteAsset(storeId, assetId, force === 'true');
    return { success: true, message: 'File deleted.' };
  }
}
