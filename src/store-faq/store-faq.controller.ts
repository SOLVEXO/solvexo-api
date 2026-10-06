/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StoreFaqService } from './store-faq.service';
import { CreateStoreFaqDto, UpdateStoreFaqDto } from './dto/create-store-faq.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv } from '../common/bulk-import/bulk-import.util';
import { STORE_FAQ_IMPORT_COLUMNS } from './store-faq-bulk-import';

@ApiTags('Store FAQs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-faq')
export class StoreFaqController {
  constructor(private readonly storeFaqService: StoreFaqService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string) {
    return this.storeFaqService.listForSeller(storeId, req.user.userId);
  }

  @Get(':storeId/import-template')
  importTemplate() {
    return buildTemplatePayload('store-faqs-import-template.csv', STORE_FAQ_IMPORT_COLUMNS);
  }

  @Post(':storeId/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  importFaqs(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file: any) {
    return this.storeFaqService.importCsv(storeId, req.user.userId, readUploadedCsv(file));
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateStoreFaqDto) {
    return this.storeFaqService.create(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/:faqId')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('faqId') faqId: string, @Body() dto: UpdateStoreFaqDto) {
    return this.storeFaqService.update(storeId, req.user.userId, faqId, dto);
  }

  @Delete(':storeId/:faqId')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('faqId') faqId: string) {
    return this.storeFaqService.remove(storeId, req.user.userId, faqId);
  }
}
