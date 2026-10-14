/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EmailHealthService } from './email-health.service';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@ApiTags('Admin email health')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@Controller('api/admin/email-health')
export class AdminEmailHealthController {
  constructor(private readonly health: EmailHealthService) {}

  @RequirePermission('config.manage')
  @Get()
  get() {
    return this.health.getHealth();
  }

  @RequirePermission('config.manage')
  @Post('test')
  test(@Req() req: any) {
    return this.health.sendTest(req.user.userId);
  }
}
