/* eslint-disable prettier/prettier */
import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PromotionsService } from './promotions.service';
import { PromotionPlacement } from '../common/promotion-placements.const';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@ApiTags('Admin Promotions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@Controller('api/admin/marketing/promotions')
export class AdminPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @RequirePermission('marketing.manage')
  @Get()
  list(@Query('status') status?: string) {
    return this.promotionsService.adminList(status);
  }

  @RequirePermission('marketing.manage')
  @Get('analytics')
  analytics() {
    return this.promotionsService.getAdminAnalytics();
  }

  @RequirePermission('marketing.manage')
  @Get('calendar')
  calendar(@Query('from') from: string, @Query('to') to: string) {
    return this.promotionsService.calendar(new Date(from), new Date(to));
  }

  @RequirePermission('marketing.manage')
  @Get('conflicts')
  conflicts(
    @Query('placement') placement: PromotionPlacement,
    @Query('startAt') startAt: string,
    @Query('endAt') endAt: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.promotionsService.checkConflicts(placement, new Date(startAt), new Date(endAt), excludeId);
  }

  @RequirePermission('marketing.manage')
  @Patch(':id/approve')
  approve(@Req() req: any, @Param('id') id: string) {
    return this.promotionsService.approve(req.user.userId, id);
  }

  @RequirePermission('marketing.manage')
  @Patch(':id/reject')
  reject(@Req() req: any, @Param('id') id: string, @Body() body: { rejectionReason: string }) {
    return this.promotionsService.reject(req.user.userId, id, body.rejectionReason);
  }
}
