/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { FaqService } from '@/faqs/faq.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';

// Help Center SEO — no Blog module exists yet in this backend (confirmed
// absent from the master doc), so "Blog SEO" is deferred; Help Center maps
// directly onto the existing FAQ module instead.
@ApiTags('Admin SEO — Help Center Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/faqs')
export class AdminSeoFaqController {
  constructor(private readonly faqService: FaqService) {}

  @Get(':id')
  getSeo(@Param('id') id: string) {
    return this.faqService.getSeo(id);
  }

  @Patch(':id')
  updateSeo(@Param('id') id: string, @Body() dto: UpdateSeoMetaDto) {
    return this.faqService.updateSeo(id, dto);
  }
}
