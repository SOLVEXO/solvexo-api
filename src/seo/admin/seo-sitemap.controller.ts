/* eslint-disable prettier/prettier */
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { SeoSitemapService } from '../services/seo-sitemap.service';

@ApiTags('Admin SEO — Sitemap')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api/admin/seo/sitemap')
export class AdminSeoSitemapController {
  constructor(private readonly sitemapService: SeoSitemapService) {}

  @Get('status')
  getStatus() {
    return this.sitemapService.getStatus();
  }

  @Post('regenerate')
  regenerate() {
    return this.sitemapService.enqueueRegenerate();
  }
}
