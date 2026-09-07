/* eslint-disable prettier/prettier */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MetafieldsService } from './metafields.service';
import { CreateDefinitionDto } from './dto/create-definition.dto';
import { UpdateDefinitionDto } from './dto/update-definition.dto';
import { SetValuesDto } from './dto/set-values.dto';
import type { MetafieldOwnerResource } from './schemas/metafield-definition.schema';

@ApiTags('Metafields (seller)')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('seller')
@UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
@Controller('api/metafields')
export class MetafieldsController {
  constructor(private readonly metafieldsService: MetafieldsService) {}

  @Get(':storeId/definitions')
  listDefinitions(@Req() req: any, @Param('storeId') storeId: string, @Query('ownerResource') ownerResource?: MetafieldOwnerResource) {
    return this.metafieldsService.listDefinitions(storeId, req.user.userId, ownerResource);
  }

  @Post(':storeId/definitions')
  createDefinition(@Req() req: any, @Param('storeId') storeId: string, @Body() dto: CreateDefinitionDto) {
    return this.metafieldsService.createDefinition(storeId, req.user.userId, dto);
  }

  @Patch(':storeId/definitions/:definitionId')
  updateDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string, @Body() dto: UpdateDefinitionDto) {
    return this.metafieldsService.updateDefinition(storeId, req.user.userId, definitionId, dto);
  }

  @Delete(':storeId/definitions/:definitionId')
  deleteDefinition(@Req() req: any, @Param('storeId') storeId: string, @Param('definitionId') definitionId: string) {
    return this.metafieldsService.deleteDefinition(storeId, req.user.userId, definitionId);
  }

  @Get(':storeId/values/:ownerResource/:ownerId')
  getValues(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('ownerResource') ownerResource: MetafieldOwnerResource,
    @Param('ownerId') ownerId: string,
  ) {
    return this.metafieldsService.getValues(storeId, req.user.userId, ownerResource, ownerId);
  }

  @Put(':storeId/values/:ownerResource/:ownerId')
  setValues(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('ownerResource') ownerResource: MetafieldOwnerResource,
    @Param('ownerId') ownerId: string,
    @Body() dto: SetValuesDto,
  ) {
    return this.metafieldsService.setValues(storeId, req.user.userId, ownerResource, ownerId, dto);
  }
}
