/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { SeoLandingPagesService } from '../services/seo-landing-pages.service';
import { CreateLandingPageDto } from '../dto/create-landing-page.dto';
import { UpdateLandingPageDto } from '../dto/update-landing-page.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Admin SEO — Landing Pages')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/landing-pages')
export class SeoLandingPagesController {
  constructor(private readonly landingPages: SeoLandingPagesService) {}

  @Post()
  create(@Req() req: any, @Body() dto: CreateLandingPageDto) {
    return this.landingPages.create(dto, { id: req.user.userId, role: req.user.role });
  }

  @Get()
  list(@Query() query: any) {
    return this.landingPages.list(query);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.landingPages.getById(id);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateLandingPageDto) {
    return this.landingPages.update(id, dto, { id: req.user.userId, role: req.user.role });
  }

  @Delete(':id')
  delete(@Req() req: any, @Param('id') id: string) {
    return this.landingPages.delete(id, { id: req.user.userId, role: req.user.role });
  }
}
