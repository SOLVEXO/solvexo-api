/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
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
