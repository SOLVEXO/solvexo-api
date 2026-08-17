/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { SeoContentService } from '../services/seo-content.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// Root/main categories are admin-curated (CategoriesService.addCategory
// requires role==='admin' to create one with no parentId), so category SEO
// override is admin-only — sellers only ever *view* category meta (Phase 7).
@ApiTags('Admin SEO — Category Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/categories')
export class AdminSeoCategoryController {
  constructor(private readonly seoContent: SeoContentService) {}

  @Get(':id')
  getSeo(@Param('id') id: string) {
    return this.seoContent.getCategorySeo(id);
  }

  @Patch(':id')
  updateSeo(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateSeoMetaDto) {
    return this.seoContent.updateCategorySeo(id, dto, { id: req.user.userId, role: req.user.role });
  }
}
