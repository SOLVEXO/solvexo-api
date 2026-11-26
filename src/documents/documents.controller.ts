import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { DocumentsService } from './documents.service';
import { CreateDocumentFileDto, ListDocumentFilesDto, PublicDocumentFilesQueryDto, UpdateDocumentFileDto } from './dto/store-document.dto';

/** Seller side: one library per store, files uploaded under `documents/<storeId>/`. */
@ApiTags('Store documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.content.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-documents')
export class DocumentAssetsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get(':storeId')
  list(@Req() req: any, @Param('storeId') storeId: string, @Query() query: ListDocumentFilesDto) {
    return this.documentsService.listForSeller(storeId, actingSellerId(req.user), query);
  }

  @Get(':storeId/stats')
  stats(@Req() req: any, @Param('storeId') storeId: string) {
    return this.documentsService.stats(storeId);
  }

  /** Step 1: upload the PDF (50 MB), get back the public id used to create the record. */
  @Post(':storeId/upload')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 55 * 1024 * 1024 } }))
  upload(@Req() req: any, @Param('storeId') storeId: string, @UploadedFile() file?: Express.Multer.File) {
    return this.documentsService.uploadFile(storeId, actingSellerId(req.user), file);
  }

  @Post(':storeId')
  create(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateDocumentFileDto) {
    return this.documentsService.create(storeId, actingSellerId(req.user), dto);
  }

  @Patch(':storeId/:id')
  update(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() dto: UpdateDocumentFileDto) {
    return this.documentsService.update(storeId, actingSellerId(req.user), id, dto);
  }

  /** Replace the file in place — every menu/button/section that shows this document updates itself. */
  @Post(':storeId/:id/replace-file')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 55 * 1024 * 1024 } }))
  replaceFile(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    return this.documentsService.uploadFile(storeId, actingSellerId(req.user), file).then(uploaded =>
      this.documentsService.update(storeId, actingSellerId(req.user), id, {
        publicId: uploaded.publicId,
        fileUrl: uploaded.fileUrl,
        sizeBytes: uploaded.sizeBytes,
      }),
    );
  }

  @Put(':storeId/:id/cover')
  cover(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string, @Body() body: { publicId?: string; url?: string }) {
    return this.documentsService.setCover(storeId, actingSellerId(req.user), id, body?.publicId, body?.url);
  }

  @Delete(':storeId/:id')
  remove(@Req() req: any, @Param('storeId') storeId: string, @Param('id') id: string) {
    return this.documentsService.remove(storeId, actingSellerId(req.user), id);
  }
}

/** Public storefront: the documents grid. The password/coming-soon gate already guards this path. */
@ApiTags('Public store documents')
@Controller('api/public/store-documents')
export class PublicDocumentAssetsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get(':storeId')
  list(@Param('storeId') storeId: string, @Query() query: PublicDocumentFilesQueryDto) {
    return this.documentsService.listPublic(storeId, query?.category);
  }
}

/** Public file endpoints: `view` opens the PDF, `download` really downloads it. */
@ApiTags('Public store documents')
@Controller('api/documents')
export class PublicDocumentFileController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get(':id/view')
  async view(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.documentsService.view(id);
    return res.redirect(302, doc.url);
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const doc = await this.documentsService.download(id);
    return res.redirect(302, doc.url);
  }
}