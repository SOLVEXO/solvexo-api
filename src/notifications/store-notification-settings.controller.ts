/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreNotificationSettingsService } from './store-notification-settings.service';
import { PreviewCustomerEmailDto, UpdateStoreNotificationSettingsDto } from './dto/update-store-notification-settings.dto';

@ApiTags('Store notification settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.general.manage')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@Controller('api/store-notifications')
export class StoreNotificationSettingsController {
  constructor(private readonly service: StoreNotificationSettingsService) {}

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.get(actingSellerId(req.user), storeId);
  }

  @Patch(':storeId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateStoreNotificationSettingsDto) {
    return this.service.update(actingSellerId(req.user), storeId, dto, { id: req.user?.userId, role: req.user?.role });
  }

  @Post(':storeId/test-email')
  sendTest(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PreviewCustomerEmailDto) {
    return this.service.sendTest(actingSellerId(req.user), storeId, dto, req.user?.email);
  }

  /** Machine translation of one email into a language, for the seller to review and save (nothing is stored). */
  @Post(':storeId/auto-translate-email')
  autoTranslateEmail(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PreviewCustomerEmailDto) {
    return this.service.autoTranslateEmail(actingSellerId(req.user), storeId, dto);
  }

  @Post(':storeId/preview')
  preview(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: PreviewCustomerEmailDto) {
    return this.service.preview(actingSellerId(req.user), storeId, dto);
  }
}
