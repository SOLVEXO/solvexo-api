/* eslint-disable prettier/prettier */
import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../../common/acting-seller-id.util';
import { ThemePackageService } from './theme-package.service';

// Imported ("Liquid") theme ZIP lifecycle — upload/import, source editing, preview, publish, rollback. Lives under
// the same `api/store-theme` prefix and permission as the native theme editor (../../store-theme/store-theme.controller.ts),
// which keeps the one storefront-theme surface the frontend already calls.
@ApiTags('Liquid Theme')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('onlinestore.themes.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/store-theme')
export class LiquidThemeController {
  constructor(private readonly themePackageService: ThemePackageService) {}

  // ZIP parsing is bounded and validated before any immutable source revision is persisted.
  @Post(':storeId/installed/:installedThemeId/package')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  uploadThemePackage(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Theme ZIP file is required');
    return this.themePackageService.upload(storeId, actingSellerId(req.user), installedThemeId, file.buffer);
  }

  // Background import: answers at once with a jobId; the dialog polls GET .../package/import/:jobId.
  @Post(':storeId/installed/:installedThemeId/package/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }))
  startThemeImport(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('Theme ZIP file is required');
    return this.themePackageService.startImport(storeId, actingSellerId(req.user), installedThemeId, file.buffer, file.originalname);
  }

  @Get(':storeId/installed/:installedThemeId/package/import/:jobId')
  getThemeImport(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Param('jobId') jobId: string) {
    return this.themePackageService.getImportJob(storeId, actingSellerId(req.user), installedThemeId, jobId);
  }

  @Get(':storeId/installed/:installedThemeId/package/:version/file')
  getThemePackageFile(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Param('version') version: string, @Query('path') path: string) {
    return this.themePackageService.getFile(storeId, actingSellerId(req.user), installedThemeId, Number(version), String(path ?? ''));
  }

  // Resumable upload: many small pieces, then one "complete" call that assembles the ZIP and starts the background import.
  @Post(':storeId/installed/:installedThemeId/package/upload/chunk')
  @UseInterceptors(FileInterceptor('chunk', { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadThemeChunk(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @UploadedFile() file: Express.Multer.File, @Body() body: { uploadId: string; index: string; total: string }) {
    if (!file) throw new BadRequestException('Upload piece is required');
    return this.themePackageService.saveUploadChunk(storeId, actingSellerId(req.user), installedThemeId, String(body?.uploadId), Number(body?.index), Number(body?.total), file.buffer);
  }

  @Post(':storeId/installed/:installedThemeId/package/upload/complete')
  completeThemeUpload(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Body() body: { uploadId: string; total: number; fileName?: string }) {
    return this.themePackageService.completeUpload(storeId, actingSellerId(req.user), installedThemeId, String(body?.uploadId), Number(body?.total), body?.fileName);
  }

  @Post(':storeId/installed/:installedThemeId/package/preview')
  previewThemePackage(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Body('version') version?: number, @Body('path') path?: string, @Body('draft') draft?: { path: string; content: string }) {
    return this.themePackageService.preview(storeId, actingSellerId(req.user), installedThemeId, version, path, draft);
  }

  @Post(':storeId/installed/:installedThemeId/package/:version/publish')
  publishThemePackage(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Param('version') version: string) {
    return this.themePackageService.publish(storeId, actingSellerId(req.user), installedThemeId, Number(version));
  }

  @Get(':storeId/installed/:installedThemeId/package')
  listThemePackageVersions(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string) {
    return this.themePackageService.list(storeId, actingSellerId(req.user), installedThemeId);
  }

  @Get(':storeId/installed/:installedThemeId/package/:version')
  getThemePackageVersion(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Param('version') version: string) {
    return this.themePackageService.getRevision(storeId, actingSellerId(req.user), installedThemeId, Number(version));
  }

  @Get(':storeId/installed/:installedThemeId/package/:version/structure')
  getThemePackageStructure(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Param('version') version: string) {
    return this.themePackageService.getStructure(storeId, actingSellerId(req.user), installedThemeId, Number(version));
  }

  @Patch(':storeId/installed/:installedThemeId/package/file')
  editThemePackageFile(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Body() body: { path: string; content: string }) {
    return this.themePackageService.editFile(storeId, actingSellerId(req.user), installedThemeId, body?.path, body?.content);
  }

  @Post(':storeId/installed/:installedThemeId/package/file')
  addThemePackageFile(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Body() body: { path: string; content: string; encoding?: 'utf8' | 'base64' }) {
    return this.themePackageService.addFile(storeId, actingSellerId(req.user), installedThemeId, body?.path, body?.content, body?.encoding);
  }

  @Delete(':storeId/installed/:installedThemeId/package/file')
  deleteThemePackageFile(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Body() body: { path: string }) {
    return this.themePackageService.deleteFile(storeId, actingSellerId(req.user), installedThemeId, body?.path);
  }

  @Post(':storeId/installed/:installedThemeId/package/file/rename')
  renameThemePackageFile(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Body() body: { from: string; to: string }) {
    return this.themePackageService.renameFile(storeId, actingSellerId(req.user), installedThemeId, body?.from, body?.to);
  }

  @Post(':storeId/installed/:installedThemeId/package/unpublish')
  unpublishThemePackage(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string) {
    return this.themePackageService.unpublish(storeId, actingSellerId(req.user), installedThemeId);
  }

  @Get(':storeId/installed/:installedThemeId/package/export/zip')
  async exportThemePackage(@Req() req: any, @Res() res: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Query('version') version?: string) {
    const { filename, buffer } = await this.themePackageService.exportZip(storeId, actingSellerId(req.user), installedThemeId, version === undefined ? undefined : Number(version));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Post(':storeId/installed/:installedThemeId/package/:version/rollback')
  rollbackThemePackage(@Req() req: any, @Param('storeId') storeId: string, @Param('installedThemeId') installedThemeId: string, @Param('version') version: string) {
    return this.themePackageService.rollback(storeId, actingSellerId(req.user), installedThemeId, Number(version));
  }
}
