/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { buildTemplatePayload, readUploadedCsv, runBulkImport } from '../common/bulk-import/bulk-import.util';
import { assertImportable, buildEntryColumns, entryFileDedupeKey, makeEntryRowHandler, unsupportedGuideColumns } from './metaobject-entries-bulk-import';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { actingSellerId } from '../common/acting-seller-id.util';
import { MetaobjectsService } from './metaobjects.service';
import { CreateMetaobjectDefinitionDto } from './dto/create-metaobject-definition.dto';
import { UpdateMetaobjectDefinitionDto } from './dto/update-metaobject-definition.dto';
import { SetEntryFieldsDto } from './dto/set-entry-fields.dto';

@ApiTags('Metaobjects (seller)')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles('seller', 'staff')
@RequirePermission('content.metaobjects.manage')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/metaobjects')
export class MetaobjectsController {
  constructor(private readonly metaobjectsService: MetaobjectsService) {}

  @Get(':storeId/definitions')
  listDefinitions(@Req() req: any, @Param('storeId') storeId: string) {
    return this.metaobjectsService.listDefinitions(storeId, actingSellerId(req.user));
  }

  @Get(':storeId/definitions/:definitionId')
  getDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metaobjectsService.getDefinition(storeId, actingSellerId(req.user), definitionId);
  }

  @Post(':storeId/definitions')
  createDefinition(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateMetaobjectDefinitionDto) {
    return this.metaobjectsService.createDefinition(storeId, actingSellerId(req.user), dto);
  }

  @Patch(':storeId/definitions/:definitionId')
  updateDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @Body() dto: UpdateMetaobjectDefinitionDto) {
    return this.metaobjectsService.updateDefinition(storeId, actingSellerId(req.user), definitionId, dto);
  }

  @Delete(':storeId/definitions/:definitionId')
  deleteDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metaobjectsService.deleteDefinition(storeId, actingSellerId(req.user), definitionId);
  }

  // CSV import (static routes declared before the dynamic entries routes).
  @Get(':storeId/definitions/:definitionId/entries/import-template')
  async entriesImportTemplate(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    const { data: definition } = await this.metaobjectsService.getDefinition(storeId, actingSellerId(req.user), definitionId);
    const payload = buildTemplatePayload(`${definition.type}-entries-import-template.csv`, buildEntryColumns(definition.fieldDefinitions));
    payload.data.columns.push(...unsupportedGuideColumns(definition.fieldDefinitions));
    return payload;
  }

  @Post(':storeId/definitions/:definitionId/entries/import')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }))
  async importEntries(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @UploadedFile() file: any) {
    const sellerId = actingSellerId(req.user);
    const text = readUploadedCsv(file);
    const { data: definition } = await this.metaobjectsService.getDefinition(storeId, sellerId, definitionId);
    assertImportable(definition.fieldDefinitions);
    return runBulkImport({
      text,
      columns: buildEntryColumns(definition.fieldDefinitions),
      maxRows: 1000,
      label: 'entry',
      fileDedupeKey: entryFileDedupeKey,
      handler: makeEntryRowHandler({
        storeId, sellerId, definitionId, fieldDefinitions: definition.fieldDefinitions,
        entryNameExists: (name) => this.metaobjectsService.entryNameExists(storeId, definitionId, name),
        createEntry: (dto) => this.metaobjectsService.createEntry(storeId, sellerId, definitionId, dto),
      }),
    });
  }

  @Get(':storeId/definitions/:definitionId/entries')
  listEntries(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metaobjectsService.listEntries(storeId, actingSellerId(req.user), definitionId);
  }

  @Post(':storeId/definitions/:definitionId/entries')
  createEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @Body() dto: SetEntryFieldsDto) {
    return this.metaobjectsService.createEntry(storeId, actingSellerId(req.user), definitionId, dto);
  }

  @Get(':storeId/entries/:entryId')
  getEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('entryId') entryId: string) {
    return this.metaobjectsService.getEntry(storeId, actingSellerId(req.user), entryId);
  }

  @Patch(':storeId/entries/:entryId')
  updateEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('entryId') entryId: string, @Body() dto: SetEntryFieldsDto) {
    return this.metaobjectsService.updateEntry(storeId, actingSellerId(req.user), entryId, dto);
  }

  @Delete(':storeId/entries/:entryId')
  deleteEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('entryId') entryId: string) {
    return this.metaobjectsService.deleteEntry(storeId, actingSellerId(req.user), entryId);
  }
}
