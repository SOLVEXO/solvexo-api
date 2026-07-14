/* eslint-disable prettier/prettier */
import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { FaqService } from 'src/faqs/faq.service';
import { UpdateSeoMetaDto } from '../dto/update-seo-meta.dto';

// Help Center SEO — no Blog module exists yet in this backend (confirmed
// absent from the master doc), so "Blog SEO" is deferred; Help Center maps
// directly onto the existing FAQ module instead.
@ApiTags('Admin SEO — Help Center Meta')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
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
