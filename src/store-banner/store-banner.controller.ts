/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFiles, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreBannerService } from './store-banner.service';
import { CreateStoreBannerDto } from './dto/create-store-banner.dto';
import { CreateStoreBannerFromUrlDto } from './dto/create-store-banner-from-url.dto';
import { UpdateStoreBannerDto } from './dto/update-store-banner.dto';

const CREATIVE_UPLOAD = FileFieldsInterceptor(
  [
    { name: 'file', maxCount: 1 },
  ],
  // 50MB — raised from the original 5MB (image-only) cap so a real Video
  // Banner clip actually fits; per-mimetype size enforcement still happens
  // in `validateCreativeDimensions` (images stay capped at 5MB there).
  { storage: memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } },
);

@ApiTags('Store Banners')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-banner')
export class StoreBannerController {
  constructor(private readonly storeBannerService: StoreBannerService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeBannerService.listForSeller(storeId, actingSellerId(req.user));
  }

  @Post(':storeId')
  @UseInterceptors(CREATIVE_UPLOAD)
  create(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: CreateStoreBannerDto,
    @UploadedFiles() files: { file?: Express.Multer.File[] },
  ) {
    return this.storeBannerService.create(storeId, actingSellerId(req.user), dto, files?.file?.[0]);
  }

  @Post(':storeId/from-url')
  createFromUrl(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateStoreBannerFromUrlDto) {
    return this.storeBannerService.createFromUrl(storeId, actingSellerId(req.user), dto);
  }

  // Declared before ':storeId/:bannerId' so "reorder" is never read as a banner id.
  @Patch(':storeId/reorder')
  reorder(@Req() req: any, @Param('storeId') storeId: string, @Body('ids') ids: string[]) {
    return this.storeBannerService.reorder(storeId, actingSellerId(req.user), ids);
  }

  @Patch(':storeId/:bannerId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string, @Body() dto: UpdateStoreBannerDto) {
    return this.storeBannerService.update(storeId, actingSellerId(req.user), bannerId, dto);
  }

  @Patch(':storeId/:bannerId/pause')
  pause(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.pause(storeId, actingSellerId(req.user), bannerId);
  }

  @Patch(':storeId/:bannerId/resume')
  resume(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.resume(storeId, actingSellerId(req.user), bannerId);
  }

  @Get(':storeId/:bannerId/timeline')
  timeline(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.timeline(storeId, actingSellerId(req.user), bannerId);
  }

  @Delete(':storeId/:bannerId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('bannerId') bannerId: string) {
    return this.storeBannerService.remove(storeId, actingSellerId(req.user), bannerId);
  }
}
