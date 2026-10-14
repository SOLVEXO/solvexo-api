/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Post, Delete, Param, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { PlatformSeoService } from '../services/platform-seo-settings.service';
import { UpdatePlatformSeoSettingsDto } from '../dto/update-platform-seo-settings.dto';
import { UpsertSeoRuleDto } from '../dto/seo-rule.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator';
@ApiTags('Admin SEO — Platform Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo')
export class PlatformSeoController {
  constructor(private readonly platformSeoService: PlatformSeoService) {}

  @RequirePermission('seo.manage')
  @Get('settings')
  getSettings() {
    return this.platformSeoService.getSettings();
  }

  @RequirePermission('seo.manage')
  @Patch('settings')
  updateSettings(@Req() req: any, @Body() dto: UpdatePlatformSeoSettingsDto) {
    return this.platformSeoService.updateSettings(dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.manage')
  @Get('rules')
  listRules() {
    return this.platformSeoService.listRules();
  }

  @RequirePermission('seo.manage')
  @Post('rules')
  upsertRule(@Req() req: any, @Body() dto: UpsertSeoRuleDto) {
    return this.platformSeoService.upsertRule(dto, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.manage')
  @Patch('rules/:code')
  updateRule(@Req() req: any, @Param('code') code: string, @Body() dto: UpsertSeoRuleDto) {
    return this.platformSeoService.upsertRule({ ...dto, code }, { id: req.user.userId, role: req.user.role });
  }

  @RequirePermission('seo.manage')
  @Delete('rules/:code')
  deleteRule(@Req() req: any, @Param('code') code: string) {
    return this.platformSeoService.deleteRule(code, { id: req.user.userId, role: req.user.role });
  }
}
