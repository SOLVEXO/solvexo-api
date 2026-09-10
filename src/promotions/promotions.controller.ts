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

const CREATIVE_UPLOAD = FileFieldsInterceptor(
  [
    { name: 'file', maxCount: 1 },
    { name: 'mobileFile', maxCount: 1 },
  ],
  { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } },
);

@ApiTags('Promotions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@Controller('api/promotions')
export class PromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get('preview-price')
  previewPrice(
    @Req() req: any,
    @Query('storeId') storeId: string,
    @Query('placement') placement: PromotionPlacement,
    @Query('startAt') startAt: string,
    @Query('endAt') endAt: string,
    @Query('isPeak') isPeak?: string,
  ) {
    return this.promotionsService.previewPrice(req.user.userId, storeId, placement, startAt, endAt, isPeak === 'true');
  }

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.promotionsService.listForSeller(req.user.userId, storeId);
  }

  @Get(':storeId/analytics')
  analytics(@Req() req: any, @Param('storeId') storeId: string) {
    return this.promotionsService.getSellerAnalytics(req.user.userId, storeId);
  }

  @Post(':storeId')
  @UseInterceptors(CREATIVE_UPLOAD)
  create(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: CreatePromotionRequestDto,
    @UploadedFiles() files: { file?: Express.Multer.File[]; mobileFile?: Express.Multer.File[] },
  ) {
    return this.promotionsService.create(req.user.userId, storeId, dto, files?.file?.[0], files?.mobileFile?.[0]);
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

  @Patch(':id/cancel')
  cancel(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.cancel(req.user.userId, id);
  }

  @Get(':id/timeline')
  timeline(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.timeline(req.user.userId, id);
  }
}
