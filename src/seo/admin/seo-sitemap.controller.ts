/* eslint-disable prettier/prettier */
import { Controller, Get, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { SeoSitemapService } from '../services/seo-sitemap.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator';
@ApiTags('Admin SEO — Sitemap')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/sitemap')
export class AdminSeoSitemapController {
  constructor(private readonly sitemapService: SeoSitemapService) {}

  @RequirePermission('seo.manage')
  @Get('status')
  getStatus() {
    return this.sitemapService.getStatus();
  }

  @RequirePermission('seo.manage')
  @Post('regenerate')
  regenerate() {
    return this.sitemapService.enqueueRegenerate();
  }
}
