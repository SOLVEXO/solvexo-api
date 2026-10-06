/* eslint-disable prettier/prettier */
import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@/auth/guards/roles.guard';
import { Roles } from '@/auth/decorators/roles.decorator';
import { SeoCanonicalService } from '../services/seo-canonical.service';
import { CreateCanonicalRuleDto } from '../dto/create-canonical-rule.dto';
import { UpdateCanonicalRuleDto } from '../dto/update-canonical-rule.dto';
import { SeoResponseInterceptor } from '../seo-response.interceptor';
import { Res, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv, runBulkImport } from '../../common/bulk-import/bulk-import.util';
import { CANONICAL_COLUMNS, canonicalFileDedupeKey, makeCanonicalRowHandler } from '../canonical-rules-bulk-import';

@ApiTags('Admin SEO — Canonical Rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@UseInterceptors(SeoResponseInterceptor)
@Controller('api/admin/seo/canonical-rules')
export class AdminSeoCanonicalController {
  constructor(private readonly canonical: SeoCanonicalService) {}

  // CSV import. `@Res()` sends the engine's own response shape (the class-level
  // SeoResponseInterceptor would otherwise wrap it a second time).
  @Get('import-template')
  importTemplate(@Res() res: any) {
    return res.json(buildTemplatePayload('canonical-rules-import-template.csv', CANONICAL_COLUMNS));
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importRules(@Req() req: any, @UploadedFile() file: any, @Res() res: any) {
    const actor = { id: req.user.userId, role: req.user.role };
    const result = await runBulkImport({
      text: readUploadedCsv(file),
      columns: CANONICAL_COLUMNS,
      maxRows: 1000,
      label: 'canonical rule',
      fileDedupeKey: canonicalFileDedupeKey,
      handler: makeCanonicalRowHandler((dto) => this.canonical.create(null, dto as any, actor)),
    });
    return res.json(result);
  }

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
