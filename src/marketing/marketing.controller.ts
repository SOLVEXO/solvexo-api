/* eslint-disable prettier/prettier */
import { AuditStoreWrites } from '@/activity-log/audit-store-writes';
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MarketingService } from './marketing.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { COUPON_IMPORT_COLUMNS } from './coupons-bulk-import';

@ApiTags('Marketing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'admin', 'staff')
@Controller('api/marketing')
export class MarketingController {
  constructor(private readonly marketingService: MarketingService) {}

  @RequirePermission('discounts.manage')
  @Get(':storeId/coupons/import-template')
  couponsImportTemplate() {
    return buildTemplatePayload('coupons-import-template.csv', COUPON_IMPORT_COLUMNS);
  }

  @RequirePermission('discounts.manage')
  @AuditStoreWrites('coupon', 'marketing')
  @Post(':storeId/coupons/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importCoupons(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.marketingService.importCouponsCsv(actingSellerId(req.user), storeId, readUploadedCsv(file), req.ip, req.headers['user-agent']);
  }

  @RequirePermission('discounts.manage')
  @Post(':storeId/coupons')
  createCoupon(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateCouponDto) {
    return this.marketingService.createCoupon(actingSellerId(req.user), storeId, dto, req.ip, req.headers['user-agent']);
  }

  @RequirePermission('discounts.manage')
  @Get(':storeId/coupons')
  getCoupons(@Req() req: any, @Param('storeId') storeId: string, @Query() query: any) {
    return this.marketingService.getCoupons(actingSellerId(req.user), storeId, query);
  }

  @RequirePermission('discounts.manage')
  @Patch(':storeId/coupons/:couponId')
  updateCoupon(@Req() req: any, @Param('storeId') storeId: string, @Param('couponId') couponId: string, @Body() dto: UpdateCouponDto) {
    return this.marketingService.updateCoupon(actingSellerId(req.user), storeId, couponId, dto, req.ip, req.headers['user-agent']);
  }

  @RequirePermission('discounts.manage')
  @Delete(':storeId/coupons/:couponId')
  deleteCoupon(@Req() req: any, @Param('storeId') storeId: string, @Param('couponId') couponId: string) {
    return this.marketingService.deleteCoupon(actingSellerId(req.user), storeId, couponId, req.ip, req.headers['user-agent']);
  }
}
