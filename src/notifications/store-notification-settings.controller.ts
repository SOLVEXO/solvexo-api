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
import { StoreMailService } from './store-mail.service';
import { SaveStoreSmtpDto } from './dto/store-smtp.dto';
import { Throttle } from '@nestjs/throttler';
import { Delete, Put } from '@nestjs/common';
import { PreviewCustomerEmailDto, UpdateStoreNotificationSettingsDto } from './dto/update-store-notification-settings.dto';

@ApiTags('Store notification settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.general.manage')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
@Controller('api/store-notifications')
export class StoreNotificationSettingsController {
  constructor(private readonly service: StoreNotificationSettingsService, private readonly storeMail: StoreMailService) {}

  // ── The store's own sender email (SMTP). Declared before the generic :storeId routes. ──
  @Get(':storeId/smtp')
  smtpView(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeMail.getView(actingSellerId(req.user), storeId);
  }

  @Put(':storeId/smtp')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async smtpSave(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: SaveStoreSmtpDto) {
    return this.storeMail.save(actingSellerId(req.user), storeId, dto, await this.service.testRecipient(actingSellerId(req.user), req.user?.email));
  }

  @Delete(':storeId/smtp')
  smtpDisable(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeMail.disable(actingSellerId(req.user), storeId);
  }

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
