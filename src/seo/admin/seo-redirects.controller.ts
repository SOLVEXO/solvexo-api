/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { SeoRedirectsService } from '../services/seo-redirects.service';
import { CreateRedirectDto } from '../dto/create-redirect.dto';
import { UpdateRedirectDto } from '../dto/update-redirect.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// Platform-level redirects — storeId is always null here. Store-scoped
// redirects are managed by the seller controller (seo-redirects.controller.ts
// in seller/), both against the same SeoRedirectsService/collection.
@ApiTags('Admin SEO — Redirects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/redirects')
export class AdminSeoRedirectsController {
  constructor(private readonly redirects: SeoRedirectsService) {}

  @Post()
  create(@Req() req: any, @Body() dto: CreateRedirectDto) {
    return this.redirects.create(null, dto, { id: req.user.userId, role: req.user.role });
  }

  @Get()
  list(@Query() query: any) {
    return this.redirects.list(null, query);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateRedirectDto) {
    return this.redirects.update(null, id, dto, { id: req.user.userId, role: req.user.role });
  }

  @Delete(':id')
  delete(@Req() req: any, @Param('id') id: string) {
    return this.redirects.delete(null, id, { id: req.user.userId, role: req.user.role });
  }
}
