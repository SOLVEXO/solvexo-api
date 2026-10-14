/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Query, Req, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor';
import { PromotionsService } from './promotions.service';
import { CreatePromotionRequestDto } from './dto/create-promotion-request.dto';
import { PromotionPlacement } from '../common/promotion-placements.const';
import { FeatureFlagGuard } from '../admin-config/guards/feature-flag.guard';
import { RequireFeature } from '../admin-config/decorators/require-feature.decorator';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
const CREATIVE_UPLOAD = FileFieldsInterceptor(
  [
    { name: 'file', maxCount: 1 },
    { name: 'mobileFile', maxCount: 1 },
  ],
  { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } },
);

@ApiTags('Promotions')
@ApiBearerAuth()
@UseGuards(FeatureFlagGuard, JwtAuthGuard, RolesGuard)
@RequireFeature('promotions')
@Roles('seller')
@Controller('api/promotions')
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get('preview-price')
  previewPrice(
    @Req() req: any,
    @Query('storeId') storeId: string,
    @Query('placement') placement: PromotionPlacement,
    @Query('startAt') startAt: string,
    @Query('endAt') endAt: string,
    @Query('isPeak') isPeak?: string,
  ) {
    return this.promotionsService.previewPrice(actingSellerId(req.user), storeId, placement, startAt, endAt, isPeak === 'true');
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.promotionsService.listForSeller(actingSellerId(req.user), storeId);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':storeId/analytics')
  analytics(@Req() req: any, @Param('storeId') storeId: string) {
    return this.promotionsService.getSellerAnalytics(actingSellerId(req.user), storeId);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Post(':storeId')
  @UseInterceptors(CREATIVE_UPLOAD)
  create(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: CreatePromotionRequestDto,
    @UploadedFiles() files: { file?: Express.Multer.File[]; mobileFile?: Express.Multer.File[] },
  ) {
    return this.promotionsService.create(actingSellerId(req.user), storeId, dto, files?.file?.[0], files?.mobileFile?.[0]);
  }

  @Post(':id/pay')
  @UseInterceptors(IdempotencyInterceptor)
  createPaymentIntent(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.createPaymentIntent(req.user.userId, id);
  }

  @Post(':id/confirm')
  confirmPayment(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.confirmPayment(req.user.userId, id);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Patch(':id/cancel')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.cancel(actingSellerId(req.user), id);
  }

  @UseGuards(PermissionsGuard)
  @Roles('seller', 'staff')
  @RequirePermission('marketing.manage')
  @Get(':id/timeline')
  timeline(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.timeline(actingSellerId(req.user), id);
  }
}
