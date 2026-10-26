/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { StoreChatSettingsService } from './store-chat-settings.service';
import { UpdateStoreChatSettingsDto } from './dto/update-store-chat-settings.dto';

@ApiTags('Store chat settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('settings.general.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-chat-settings')
export class StoreChatSettingsController {
  constructor(private readonly service: StoreChatSettingsService) {}

  @Get(':storeId')
  get(@Req() req: any, @Param('storeId') storeId: string) {
    return this.service.getForSeller(storeId, actingSellerId(req.user));
  }

  @Patch(':storeId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: UpdateStoreChatSettingsDto) {
    return this.service.update(storeId, actingSellerId(req.user), dto);
  }
}
