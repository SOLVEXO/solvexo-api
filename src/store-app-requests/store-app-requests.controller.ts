/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Post, Req, UploadedFiles, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreAppRequestsService } from './store-app-requests.service';
import { CreateStoreAppRequestDto } from './dto/create-store-app-request.dto';

// 15MB covers the feature graphic's own cap (the larger of the two assets);
// the icon's tighter 1MB limit is enforced in the service, where each file
// can be checked against its own spec individually.
const APP_ASSET_UPLOAD = FileFieldsInterceptor(
  [
    { name: 'icon', maxCount: 1 },
    { name: 'featureGraphic', maxCount: 1 },
  ],
  { storage: memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } },
);

@ApiTags('Store App Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-app-requests')
export class StoreAppRequestsController {
  constructor(private readonly storeAppRequestsService: StoreAppRequestsService) {}

  @Post(':storeId')
  @UseInterceptors(APP_ASSET_UPLOAD)
  create(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Body() dto: CreateStoreAppRequestDto,
    @UploadedFiles() files: { icon?: Express.Multer.File[]; featureGraphic?: Express.Multer.File[] },
  ) {
    return this.storeAppRequestsService.create(req.user.userId, storeId, dto, files?.icon?.[0], files?.featureGraphic?.[0]);
  }

  @Get(':storeId')
  getForStore(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeAppRequestsService.getForStore(req.user.userId, storeId);
  }

  // Each platform (Android/iOS) is its own paid build — requested only once
  // its own PaymentIntent is confirmed. Lets a seller buy Android now and iOS
  // later without resubmitting the app profile — see
  // StoreAppRequestsService.createPlatformPaymentIntent/confirmPlatformPayment.
  @Post(':storeId/platforms/:platform/pay')
  createPlatformPaymentIntent(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('platform') platform: string,
  ) {
    return this.storeAppRequestsService.createPlatformPaymentIntent(req.user.userId, storeId, platform as 'android' | 'ios');
  }

  @Post(':storeId/platforms/:platform/confirm')
  confirmPlatformPayment(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('platform') platform: string,
  ) {
    return this.storeAppRequestsService.confirmPlatformPayment(req.user.userId, storeId, platform as 'android' | 'ios');
  }
}
