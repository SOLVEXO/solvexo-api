/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { SeoCanonicalService } from '../services/seo-canonical.service';
import { CreateCanonicalRuleDto } from '../dto/create-canonical-rule.dto';
import { UpdateCanonicalRuleDto } from '../dto/update-canonical-rule.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

@ApiTags('Admin SEO — Canonical Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/canonical-rules')
export class AdminSeoCanonicalController {
  constructor(private readonly canonical: SeoCanonicalService) {}

  @Post()
  create(@Req() req: any, @Body() dto: CreateCanonicalRuleDto) {
    return this.canonical.create(null, dto, { id: req.user.userId, role: req.user.role });
  }

  @Get()
  list(@Query() query: any) {
    return this.canonical.list(null, query);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateCanonicalRuleDto) {
    return this.canonical.update(null, id, dto, { id: req.user.userId, role: req.user.role });
  }

  @Delete(':id')
  delete(@Req() req: any, @Param('id') id: string) {
    return this.canonical.delete(null, id, { id: req.user.userId, role: req.user.role });
  }
}
