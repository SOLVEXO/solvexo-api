/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MetaobjectsService } from './metaobjects.service';
import { CreateMetaobjectDefinitionDto } from './dto/create-metaobject-definition.dto';
import { UpdateMetaobjectDefinitionDto } from './dto/update-metaobject-definition.dto';
import { SetEntryFieldsDto } from './dto/set-entry-fields.dto';

@ApiTags('Metaobjects (seller)')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/metaobjects')
export class MetaobjectsController {
  constructor(private readonly metaobjectsService: MetaobjectsService) {}

  @Get(':storeId/definitions')
  listDefinitions(@Req() req: any, @Param('storeId') storeId: string) {
    return this.metaobjectsService.listDefinitions(storeId, req.user.userId);
  }

  @Get(':storeId/definitions/:definitionId')
  getDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metaobjectsService.getDefinition(storeId, req.user.userId, definitionId);
  }

  @Post(':storeId/definitions')
  createDefinition(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateMetaobjectDefinitionDto) {
    return this.metaobjectsService.createDefinition(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/definitions/:definitionId')
  updateDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @Body() dto: UpdateMetaobjectDefinitionDto) {
    return this.metaobjectsService.updateDefinition(storeId, req.user.userId, definitionId, dto);
  }

  @Delete(':storeId/definitions/:definitionId')
  deleteDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metaobjectsService.deleteDefinition(storeId, req.user.userId, definitionId);
  }

  @Get(':storeId/definitions/:definitionId/entries')
  listEntries(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metaobjectsService.listEntries(storeId, req.user.userId, definitionId);
  }

  @Post(':storeId/definitions/:definitionId/entries')
  createEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @Body() dto: SetEntryFieldsDto) {
    return this.metaobjectsService.createEntry(storeId, req.user.userId, definitionId, dto);
  }

  @Get(':storeId/entries/:entryId')
  getEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('entryId') entryId: string) {
    return this.metaobjectsService.getEntry(storeId, req.user.userId, entryId);
  }

  @Patch(':storeId/entries/:entryId')
  updateEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('entryId') entryId: string, @Body() dto: SetEntryFieldsDto) {
    return this.metaobjectsService.updateEntry(storeId, req.user.userId, entryId, dto);
  }

  @Delete(':storeId/entries/:entryId')
  deleteEntry(@Req() req: any, @Param('storeId') storeId: string, @Param('entryId') entryId: string) {
    return this.metaobjectsService.deleteEntry(storeId, req.user.userId, entryId);
  }
}
