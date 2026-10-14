/* eslint-disable prettier/prettier */
import { Controller, Get, Param, Patch, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AdminModerationService } from './admin-moderation.service';
import { ModerationQueryDto } from './dto/moderation-query.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@ApiTags('Admin Moderation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/admin/moderation')
export class AdminModerationController {
  constructor(private readonly adminModerationService: AdminModerationService) {}

  private meta(req: any) {
    return { adminId: req.user.userId, ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @RequirePermission('clients.view')
  @Get('stats')
  getStats() {
    return this.adminModerationService.getStats();
  }

  @RequirePermission('clients.view')
  @Get('queue')
  getQueue(@Query() query: ModerationQueryDto) {
    return this.adminModerationService.getQueue(query);
  }

  @RequirePermission('clients.manage')
  @Patch(':id/review')
  markReviewed(@Req() req: any, @Param('id') id: string) {
    return this.adminModerationService.markReviewed(id, this.meta(req));
  }

  @RequirePermission('clients.manage')
  @Patch(':id/approve')
  approve(@Req() req: any, @Param('id') id: string) {
    return this.adminModerationService.approve(id, this.meta(req));
  }

  @RequirePermission('clients.manage')
  @Patch(':id/remove')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.adminModerationService.remove(id, this.meta(req));
  }
}
