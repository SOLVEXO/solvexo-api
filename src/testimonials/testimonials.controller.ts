import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv, runBulkImport } from '../common/bulk-import/bulk-import.util';
import { TESTIMONIAL_COLUMNS, makeTestimonialRowHandler, testimonialFileDedupeKey } from './testimonials-bulk-import';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TestimonialsService } from './testimonials.service';
import { CreateTestimonialDto, UpdateTestimonialDto, SubmitTestimonialDto } from './dto/testimonial.dto';

import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
@ApiTags('Testimonials')
@Controller('api/testimonials')
export class TestimonialsController {
  constructor(private readonly testimonialsService: TestimonialsService) {}

  // ── PUBLIC (No Auth) — homepage "Trusted by creators worldwide" section ──
  @Get()
  getActive(@Query('limit') limit?: string) {
    return this.testimonialsService.findAllActive(Math.min(12, parseInt(limit || '6', 10) || 6));
  }

  // ── SELLER (Auth Required) — self-submit a testimonial for review ───────
  @Get('mine')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @ApiBearerAuth()
  getMine(@Req() req: any) {
    return this.testimonialsService.getMySubmission(req.user.userId);
  }

  @Post('submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('seller')
  @ApiBearerAuth()
  submit(@Req() req: any, @Body() dto: SubmitTestimonialDto) {
    return this.testimonialsService.submitAsSeller(req.user.userId, dto);
  }

  // ── ADMIN (Auth Required) ────────────────────────────────────────────────
  @RequirePermission('content.manage')
  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  getAll() {
    return this.testimonialsService.findAll();
  }

  // CSV import (static routes; no `:id` GET/POST exists to swallow them).
  @RequirePermission('content.manage')
  @Get('import-template')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  importTemplate() {
    return buildTemplatePayload('testimonials-import-template.csv', TESTIMONIAL_COLUMNS);
  }

  @RequirePermission('content.manage')
  @Post('import')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importTestimonials(@UploadedFile() file: any) {
    return runBulkImport({
      text: readUploadedCsv(file),
      columns: TESTIMONIAL_COLUMNS,
      maxRows: 1000,
      label: 'testimonial',
      fileDedupeKey: testimonialFileDedupeKey,
      handler: makeTestimonialRowHandler({
        exists: (n, t) => this.testimonialsService.existsByNameAndText(n, t),
        create: (dto) => this.testimonialsService.create(dto as CreateTestimonialDto),
      }),
    });
  }

  @RequirePermission('content.manage')
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  create(@Body() dto: CreateTestimonialDto) {
    return this.testimonialsService.create(dto);
  }

  @RequirePermission('content.manage')
  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  update(@Param('id') id: string, @Body() dto: UpdateTestimonialDto) {
    return this.testimonialsService.update(id, dto);
  }

  @RequirePermission('content.manage')
  @Put(':id/toggle')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  toggle(@Param('id') id: string) {
    return this.testimonialsService.toggleActive(id);
  }

  @RequirePermission('content.manage')
  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  remove(@Param('id') id: string) {
    return this.testimonialsService.remove(id);
  }

  @RequirePermission('content.manage')
  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  approve(@Param('id') id: string) {
    return this.testimonialsService.approve(id);
  }

  @RequirePermission('content.manage')
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles('admin')
  @ApiBearerAuth()
  reject(@Param('id') id: string) {
    return this.testimonialsService.reject(id);
  }
}
