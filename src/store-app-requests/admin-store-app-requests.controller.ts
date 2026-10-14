/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreAppRequestsService } from './store-app-requests.service';
import { UpdatePlatformStatusDto } from './dto/update-platform-status.dto';
import { StoreAppPlatformStatus } from './schemas/store-app-request.schema';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@ApiTags('Admin Store App Requests')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/store-app-requests')
export class AdminStoreAppRequestsController {
  constructor(private readonly storeAppRequestsService: StoreAppRequestsService) {}

  // storeName/storeSlug are joined in server-side (see adminList) so every
  // row already shows which store sent it — no separate store lookup needed.
  @RequirePermission('apps.manage')
  @Get()
  list(@Query('status') status?: StoreAppPlatformStatus, @Query('platform') platform?: 'android' | 'ios') {
    return this.storeAppRequestsService.adminList({ status, platform });
  }

  @RequirePermission('apps.manage')
  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.storeAppRequestsService.adminGetOne(id);
  }

  @RequirePermission('apps.manage')
  @Patch(':id/platform-status')
  updatePlatformStatus(@Req() req: any, @Param('id') id: string, @Body() dto: UpdatePlatformStatusDto) {
    return this.storeAppRequestsService.updatePlatformStatus(req.user.userId, id, dto);
  }
}
