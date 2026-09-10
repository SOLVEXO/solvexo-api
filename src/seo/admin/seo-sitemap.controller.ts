/* eslint-disable prettier/prettier */
import { Controller, Get, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { SeoSitemapService } from '../services/seo-sitemap.service';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Admin SEO — Sitemap')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
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
